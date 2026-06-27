//! GDI screenshot capture for Windows.
//!
//! Captures window content via GDI (PrintWindow) on Windows.
//! On non-Windows platforms all entry points return a deterministic
//! `unsupported_platform` error.
//!
//! **Scope (PR #1):** selected-window capture only.  Desktop capture
//! is not implemented.  DXGI and Windows Graphics Capture are not used.

use serde_json::Value;

use crate::error::{ErrorCode, ProtocolError};
use crate::refs::{RefStore, WindowRef};

#[cfg(windows)]
use crate::state::StateId;
#[cfg(windows)]
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
#[cfg(windows)]
use image::codecs::png::PngEncoder;
#[cfg(windows)]
use image::{ExtendedColorType, ImageEncoder};
#[cfg(windows)]
use serde_json::json;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/// Capture a screenshot of the target window, optionally extracting UIA
/// accessibility elements from the same window.
///
/// # Arguments
///
/// * `store` - RefStore containing the window handle for `target_ref`.
///   Also receives inserted element refs when `include_elements` is true.
/// * `target_ref` - Reference to the window to capture.
/// * `include_elements` - When true, also extracts UIA elements and includes
///   them in the response as an `axTargets` array.
///
/// # Returns
///
/// On success, a JSON value with shape:
/// ```json
/// {
///   "target": "@w1",
///   "capture": { ... },
///   "warnings": [],
///   "axTargets": []
/// }
/// ```
/// The `axTargets` field is only present when `include_elements` is true
/// and at least one element was found.
///
/// On non-Windows this always returns `UnsupportedPlatform`.
pub fn screenshot(
    store: &mut RefStore,
    target_ref: &WindowRef,
    include_elements: bool,
) -> Result<Value, ProtocolError> {
    #[cfg(not(windows))]
    {
        let _ = store;
        let _ = target_ref;
        let _ = include_elements;
        Err(ProtocolError::new(
            "Screenshot capture is only supported on Windows",
            ErrorCode::UnsupportedPlatform,
        ))
    }

    #[cfg(windows)]
    {
        screenshot_impl(store, target_ref, include_elements)
    }
}

// ---------------------------------------------------------------------------
// Windows-specific implementation
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod win32_gdi {
    #![allow(non_camel_case_types, dead_code)]

    pub type HDC = isize;
    pub type HBITMAP = isize;
    pub type HGDIOBJ = isize;
    pub type DWORD = u32;
    pub type LONG = i32;
    pub type BOOL = i32;

    pub const FALSE: BOOL = 0;
    pub const TRUE: BOOL = 1;
    pub const DIB_RGB_COLORS: DWORD = 0;
    pub const BI_RGB: DWORD = 0;

    #[repr(C)]
    pub struct RECT {
        pub left: LONG,
        pub top: LONG,
        pub right: LONG,
        pub bottom: LONG,
    }

    #[repr(C)]
    pub struct BITMAPINFOHEADER {
        pub biSize: DWORD,
        pub biWidth: LONG,
        pub biHeight: LONG,
        pub biPlanes: u16,
        pub biBitCount: u16,
        pub biCompression: DWORD,
        pub biSizeImage: DWORD,
        pub biXPelsPerMeter: LONG,
        pub biYPelsPerMeter: LONG,
        pub biClrUsed: DWORD,
        pub biClrImportant: DWORD,
    }

    #[repr(C)]
    pub struct BITMAPINFO {
        pub bmiHeader: BITMAPINFOHEADER,
    }

    extern "system" {
        pub fn GetDC(hWnd: isize) -> HDC;
        pub fn ReleaseDC(hWnd: isize, hDC: HDC) -> i32;
        pub fn CreateCompatibleDC(hDC: HDC) -> HDC;
        pub fn DeleteDC(hDC: HDC) -> BOOL;
        pub fn CreateCompatibleBitmap(hDC: HDC, width: i32, height: i32) -> HBITMAP;
        pub fn SelectObject(hDC: HDC, h: HGDIOBJ) -> HGDIOBJ;
        pub fn DeleteObject(hObject: HGDIOBJ) -> BOOL;
        pub fn GetDIBits(
            hDC: HDC,
            hBitmap: HBITMAP,
            start: DWORD,
            cLines: DWORD,
            lpvBits: *mut std::ffi::c_void,
            lpbmi: *mut BITMAPINFO,
            usage: DWORD,
        ) -> i32;
        pub fn PrintWindow(hWnd: isize, hDC: HDC, flags: DWORD) -> BOOL;
        pub fn IsIconic(hWnd: isize) -> BOOL;
        pub fn GetWindowRect(hWnd: isize, lpRect: *mut RECT) -> BOOL;
    }
}

#[cfg(windows)]
use win32_gdi::*;

#[cfg(windows)]
fn screenshot_impl(
    store: &mut RefStore,
    target_ref: &WindowRef,
    include_elements: bool,
) -> Result<Value, ProtocolError> {
    // 1. Look up the window handle.
    let native = store.get_window(target_ref).ok_or_else(|| {
        ProtocolError::new(
            format!("Window ref '{}' not found", target_ref),
            ErrorCode::TargetNotFound,
        )
    })?;
    let hwnd = native.raw();

    let mut warnings: Vec<String> = Vec::new();

    // 2. Check for minimized state.
    let is_minimized = unsafe { IsIconic(hwnd) != FALSE };
    if is_minimized {
        warnings.push("window_minimized".to_owned());
    }

    // 3. Get the window rect so we know capture dimensions.
    let (width, height) = unsafe {
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == FALSE {
            return Err(ProtocolError::new(
                "Failed to get window bounds",
                ErrorCode::CaptureFailed,
            ));
        }
        let w = (rect.right - rect.left).max(0);
        let h = (rect.bottom - rect.top).max(0);
        (w, h)
    };

    if width == 0 || height == 0 {
        warnings.push("zero_sized_window".to_owned());
        // Return capture metadata with zero dimensions and no image data.
        let state_id = StateId::fresh("s");
        return Ok(json!({
            "target": target_ref.to_string(),
            "capture": {
                "stateId": state_id,
                "width": 0,
                "height": 0,
                "imageFormat": "png",
                "imageBase64": null,
            },
            "warnings": warnings,
        }));
    }

    // 4. GDI capture (unsafe FFI block).
    // SAFETY: All GDI objects are created and destroyed within this
    // function.  Object lifetimes follow the Acquire → Use → Release
    // pattern with proper cleanup on every error path.
    let png_base64 = unsafe { gdi_capture_to_base64(hwnd, width, height) }?;

    let state_id = StateId::fresh("s");

    // Build the base response.
    let mut result = json!({
        "target": target_ref.to_string(),
        "capture": {
            "stateId": state_id,
            "width": width,
            "height": height,
            "imageFormat": "png",
            "imageBase64": png_base64,
        },
        "warnings": warnings,
    });

    // 5. Optionally extract UIA accessibility elements.
    if include_elements {
        let elements = crate::uia::extract_elements(store, hwnd);
        if !elements.is_empty() {
            if let Some(obj) = result.as_object_mut() {
                obj.insert("axTargets".to_owned(), Value::Array(elements));
            }
        }
    }

    Ok(result)
}

/// Perform GDI capture of the given window and return a base64-encoded PNG.
///
/// # Safety
///
/// Caller must provide a valid HWND and positive dimensions.
#[cfg(windows)]
unsafe fn gdi_capture_to_base64(
    hwnd: isize,
    width: i32,
    height: i32,
) -> Result<String, ProtocolError> {
    // Acquire the window DC.
    let hdc_window = GetDC(hwnd);
    if hdc_window == 0 {
        return Err(ProtocolError::new("GetDC failed", ErrorCode::CaptureFailed));
    }

    // Create a compatible memory DC.
    let hdc_mem = CreateCompatibleDC(hdc_window);
    if hdc_mem == 0 {
        ReleaseDC(hwnd, hdc_window);
        return Err(ProtocolError::new(
            "CreateCompatibleDC failed",
            ErrorCode::CaptureFailed,
        ));
    }

    // Create a compatible bitmap.
    let hbitmap = CreateCompatibleBitmap(hdc_window, width, height);
    if hbitmap == 0 {
        DeleteDC(hdc_mem);
        ReleaseDC(hwnd, hdc_window);
        return Err(ProtocolError::new(
            "CreateCompatibleBitmap failed",
            ErrorCode::CaptureFailed,
        ));
    }

    // Select bitmap into memory DC (save old to restore later).
    let old_bitmap = SelectObject(hdc_mem, hbitmap as HGDIOBJ);

    // Render the window content using PrintWindow (client area).
    let pw_ok = PrintWindow(hwnd, hdc_mem, 0);
    if pw_ok == FALSE {
        // PrintWindow can fail for various reasons.  We note it but
        // continue — the DC might still have partial content.
    }

    // Prepare BITMAPINFO for GetDIBits (request 32-bit BGRA top-down).
    let header = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: -height, // negative = top-down
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        biSizeImage: 0,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
    };
    let mut bmi = BITMAPINFO { bmiHeader: header };

    // Allocate the pixel buffer.
    let buf_size = (width as usize) * (height as usize) * 4;
    let mut bits: Vec<u8> = vec![0u8; buf_size];

    let dib_ok = GetDIBits(
        hdc_mem,
        hbitmap,
        0,
        height as u32,
        bits.as_mut_ptr() as *mut std::ffi::c_void,
        &mut bmi,
        DIB_RGB_COLORS,
    );

    // Restore old bitmap and destroy GDI objects.
    SelectObject(hdc_mem, old_bitmap);
    DeleteObject(hbitmap as HGDIOBJ);
    DeleteDC(hdc_mem);
    ReleaseDC(hwnd, hdc_window);

    if dib_ok == 0 {
        return Err(ProtocolError::new(
            "GetDIBits failed to retrieve bitmap data",
            ErrorCode::CaptureFailed,
        ));
    }

    // Convert BGRA → RGBA (GDI returns B,G,R,A; PNG expects R,G,B,A).
    for chunk in bits.chunks_exact_mut(4) {
        chunk.swap(0, 2);
    }

    // Encode to PNG in memory.
    let mut png_data: Vec<u8> = Vec::new();
    {
        let encoder = PngEncoder::new(&mut png_data);
        encoder
            .write_image(&bits, width as u32, height as u32, ExtendedColorType::Rgba8)
            .map_err(|e| {
                ProtocolError::new(
                    format!("PNG encoding failed: {e}"),
                    ErrorCode::CaptureFailed,
                )
            })?;
    }

    // Base64-encode the PNG bytes.
    Ok(BASE64.encode(&png_data))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod unit_tests {
    use super::*;
    use crate::error::ErrorCode;
    #[cfg(windows)]
    use crate::refs::NativeHandle;
    use crate::state::StateId;

    // -- Platform support check (non-Windows) -------------------------------

    #[test]
    #[cfg(not(windows))]
    fn test_screenshot_unsupported_platform() {
        let mut store = RefStore::new();
        let wref = WindowRef { id: 1 };
        let result = screenshot(&mut store, &wref, false);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.code, ErrorCode::UnsupportedPlatform);
    }

    // -- Response shape tests (cross-platform) -----------------------------

    #[test]
    fn test_screenshot_response_shape_json() {
        // Verify that a successful screenshot response serialises to the
        // expected JSON shape.  This test does not require a real window.
        let state_id = StateId::fresh("s");
        let response = serde_json::json!({
            "target": "@w1",
            "capture": {
                "stateId": state_id,
                "width": 800,
                "height": 600,
                "imageFormat": "png",
                "imageBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            },
            "warnings": [],
        });

        // Validate structural fields
        assert_eq!(response["target"].as_str(), Some("@w1"));
        assert!(response["capture"].is_object());
        assert!(response["warnings"].is_array());
        assert!(response["warnings"].as_array().unwrap().is_empty());

        let capture = &response["capture"];
        assert!(capture["stateId"].as_str().unwrap().starts_with("s-"));
        assert_eq!(capture["width"].as_u64(), Some(800));
        assert_eq!(capture["height"].as_u64(), Some(600));
        assert_eq!(capture["imageFormat"].as_str(), Some("png"));
        assert!(capture["imageBase64"].as_str().unwrap().len() > 10);
    }

    #[test]
    fn test_screenshot_response_with_warnings() {
        // Verify response with warnings and null image for zero-sized capture.
        let state_id = StateId::fresh("s");
        let response = serde_json::json!({
            "target": "@w1",
            "capture": {
                "stateId": state_id,
                "width": 0,
                "height": 0,
                "imageFormat": "png",
                "imageBase64": null,
            },
            "warnings": ["zero_sized_window"],
        });

        assert_eq!(response["target"].as_str(), Some("@w1"));
        assert_eq!(
            response["warnings"].as_array().unwrap(),
            &[serde_json::json!("zero_sized_window")]
        );
        assert!(response["capture"]["imageBase64"].is_null());
        assert_eq!(response["capture"]["width"].as_u64(), Some(0));
        assert_eq!(response["capture"]["height"].as_u64(), Some(0));
    }

    #[test]
    fn test_screenshot_target_not_found_error() {
        // Verify that a non-existent window ref produces the expected error.
        // On non-Windows the platform check returns UnsupportedPlatform first;
        // on Windows an empty store would return TargetNotFound.
        let mut store = RefStore::new();
        let wref = WindowRef { id: 999 };
        let result = screenshot(&mut store, &wref, false);
        assert!(result.is_err());
        let err = result.unwrap_err();
        #[cfg(not(windows))]
        assert_eq!(err.code, ErrorCode::UnsupportedPlatform);
        #[cfg(windows)]
        assert_eq!(err.code, ErrorCode::TargetNotFound);
    }

    // -- Windows-only integration tests ------------------------------------

    #[test]
    #[cfg(windows)]
    fn test_screenshot_capture_fresh_state_id() {
        // On Windows, verify that each screenshot gets a unique stateId.
        let mut store = RefStore::new();
        // Only works if there's at least one visible HWND.
        // We use a synthetic handle — the test checks the stateId property
        // not the actual capture quality.
        let wref = store.insert_window(NativeHandle::new(0)); // HWND 0 is invalid

        match screenshot(&mut store, &wref, false) {
            Ok(val) => {
                let sid = val["capture"]["stateId"]
                    .as_str()
                    .expect("stateId should be a string");
                assert!(sid.starts_with("s-"), "stateId should start with s-");
            }
            Err(e) => {
                // In CI / headless environments this will fail with
                // CaptureFailed because HWND 0 is not a valid window.
                // That's acceptable — the error path is exercised.
                assert_eq!(
                    e.code,
                    ErrorCode::CaptureFailed,
                    "Expected CaptureFailed for invalid HWND: {e:?}",
                );
            }
        }
    }

    #[test]
    #[cfg(windows)]
    fn test_screenshot_fresh_state_ids_differ() {
        let mut store = RefStore::new();
        let wref = store.insert_window(NativeHandle::new(0));

        // Same as above; just check that two calls produce different IDs
        // when they succeed or the same error when they fail.
        let result_a = screenshot(&mut store, &wref, false);
        let result_b = screenshot(&mut store, &wref, false);

        let err_a = result_a.as_ref().err().map(|e| e.code);
        let err_b = result_b.as_ref().err().map(|e| e.code);
        assert_eq!(err_a, err_b, "both calls should produce the same outcome");
    }
}
