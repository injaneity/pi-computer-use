//! Protocol types for the pi-computer-use Windows helper.
//!
//! This crate provides the JSON-lines protocol types used to communicate
//! between the TypeScript host and the Rust helper binary.

pub mod capture;
pub mod error;
pub mod input;
pub mod protocol;
pub mod refs;
pub mod state;
pub mod uia;
pub mod window;

pub use error::{ErrorCode, ProtocolError};
pub use protocol::{Request, Response};
