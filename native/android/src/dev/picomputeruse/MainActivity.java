package dev.picomputeruse;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.graphics.Typeface;
import android.text.method.PasswordTransformationMethod;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Explicit setup and emergency stop.
 * Every control uses the same flat surface style: no elevation, same radii, ripple feedback.
 * Pairing is never an exported intent side effect.
 */
public final class MainActivity extends Activity {
    private static volatile boolean visible;
    public static boolean isVisible() { return visible; }

    private TextView serviceValue;
    private TextView controlValue;
    private TextView serviceNote;
    private View statusDot;
    private EditText secret;
    private Button showSecret;
    private Button pasteSecret;
    private Button pauseButton;
    private Button resumeButton;
    private Button revokeButton;
    private boolean revealed;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setClipToPadding(false);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(content, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        setContentView(scroll);
        applySystemBarInsets(scroll, content);

        content.addView(text(getString(R.string.app_name), 26, R.color.text_primary, true), top(16));
        content.addView(text(getString(R.string.ui_subtitle), 14, R.color.text_secondary, false), top(4));

        content.addView(section(R.string.ui_section_about), top(24));
        LinearLayout about = card();
        about.addView(text(getString(R.string.ui_about_body), 14, R.color.text_primary, false));
        TextView warning = text(getString(R.string.ui_about_warning), 14, R.color.warn, false);
        warning.setPadding(0, dp(10), 0, 0);
        about.addView(warning);
        TextView steps = text(getString(R.string.ui_steps), 14, R.color.text_secondary, false);
        steps.setPadding(0, dp(12), 0, 0);
        steps.setLineSpacing(dp(4), 1f);
        about.addView(steps);
        content.addView(about, top(8));

        content.addView(section(R.string.ui_section_status), top(24));
        LinearLayout statusCard = card();
        statusCard.addView(statusHeader());
        statusCard.addView(statusRow(R.string.ui_label_service, true), top(10));
        statusCard.addView(statusRow(R.string.ui_label_control, false), top(4));
        serviceNote = text("", 12, R.color.text_secondary, false);
        serviceNote.setPadding(0, dp(8), 0, 0);
        statusCard.addView(serviceNote);
        TextView loopback = text(getString(R.string.ui_loopback), 12, R.color.text_secondary, false);
        loopback.setPadding(0, dp(10), 0, 0);
        statusCard.addView(loopback);
        content.addView(statusCard, top(8));

        content.addView(section(R.string.ui_section_pair), top(24));
        LinearLayout pair = card();
        pair.addView(text(getString(R.string.ui_pair_hint), 13, R.color.text_secondary, false));
        pair.addView(secretField(), top(10));
        pair.addView(filledButton(getString(R.string.ui_action_pair), this::confirmPairing), top(12));
        pair.addView(softButton(getString(R.string.ui_action_accessibility),
            () -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))), top(8));
        content.addView(pair, top(8));

        content.addView(section(R.string.ui_section_control), top(24));
        LinearLayout control = card();
        pauseButton = softButton(getString(R.string.ui_action_pause), this::pause);
        resumeButton = softButton(getString(R.string.ui_action_resume), this::resume);
        revokeButton = dangerButton(getString(R.string.ui_action_revoke), this::confirmRevoke);
        control.addView(pauseButton);
        control.addView(resumeButton, top(8));
        control.addView(revokeButton, top(8));
        content.addView(control, top(8));

        content.addView(section(R.string.ui_section_test), top(24));
        LinearLayout test = card();
        test.addView(text(getString(R.string.ui_test_hint), 13, R.color.text_secondary, false));
        test.addView(softButton(getString(R.string.ui_action_fixture),
            () -> startActivity(new Intent(this, FixtureActivity.class))), top(10));
        content.addView(test, top(8));

        refresh();
    }

    @Override public void onStart() { super.onStart(); visible = true; }
    @Override public void onStop() { visible = false; super.onStop(); }
    @Override public void onResume() { super.onResume(); refresh(); }
    @Override public void onWindowFocusChanged(boolean hasFocus) { super.onWindowFocusChanged(hasFocus); if (hasFocus) refresh(); }

    private void applySystemBarInsets(ScrollView scroll, LinearLayout content) { Ui.applyInsets(scroll, content); }

    private View statusHeader() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        statusDot = new View(this);
        statusDot.setBackground(Ui.dot(color(R.color.text_secondary)));
        row.addView(statusDot, new LinearLayout.LayoutParams(dp(10), dp(10)));
        TextView label = text(getString(R.string.ui_section_status), 12, R.color.text_secondary, true);
        label.setLetterSpacing(0.08f);
        label.setPadding(dp(8), 0, 0, 0);
        row.addView(label);
        return row;
    }

    private View statusRow(int labelRes, boolean service) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.addView(text(getString(labelRes), 15, R.color.text_secondary, false),
            new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView value = text("", 15, R.color.text_primary, true);
        row.addView(value);
        if (service) serviceValue = value; else controlValue = value;
        return row;
    }

    private View secretField() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);

        secret = new EditText(this);
        secret.setHint(R.string.ui_secret_hint);
        secret.setSingleLine(true);
        secret.setTextSize(14);
        secret.setTypeface(Typeface.MONOSPACE);
        secret.setTextColor(color(R.color.text_primary));
        secret.setHintTextColor(color(R.color.text_secondary));
        secret.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        secret.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        secret.setBackground(Ui.shape(color(R.color.surface_alt), dp(12), 0, 0));
        secret.setPadding(dp(12), dp(11), dp(12), dp(11));
        secret.setMinHeight(dp(46));
        secret.setMinimumHeight(dp(46));
        row.addView(secret, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        pasteSecret = chip(getString(R.string.ui_action_paste), this::pasteFromClipboard);
        LinearLayout.LayoutParams pasteParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, dp(46));
        pasteParams.leftMargin = dp(8);
        row.addView(pasteSecret, pasteParams);

        showSecret = chip(getString(R.string.ui_action_show), this::toggleSecret);
        LinearLayout.LayoutParams showParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, dp(46));
        showParams.leftMargin = dp(8);
        row.addView(showSecret, showParams);
        return row;
    }

    private void toggleSecret() {
        revealed = !revealed;
        secret.setTransformationMethod(revealed ? null : PasswordTransformationMethod.getInstance());
        secret.setSelection(secret.getText().length());
        showSecret.setText(revealed ? R.string.ui_action_hide : R.string.ui_action_show);
    }

    private void pasteFromClipboard() {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData clip = clipboard == null ? null : clipboard.getPrimaryClip();
        CharSequence value = clip == null || clip.getItemCount() == 0 ? null : clip.getItemAt(0).coerceToText(this);
        String trimmed = value == null ? "" : value.toString().trim();
        if (trimmed.isEmpty()) { toast(R.string.ui_error_clipboard); return; }
        secret.setText(trimmed);
        secret.setSelection(trimmed.length());
        if (!Auth.validSecret(trimmed)) secret.setError(getString(R.string.ui_error_secret));
    }

    private void confirmPairing() {
        String value = secret.getText().toString().trim();
        if (!Auth.validSecret(value)) {
            secret.setError(getString(R.string.ui_error_secret));
            secret.requestFocus();
            return;
        }
        new AlertDialog.Builder(this)
            .setTitle(R.string.ui_pair_confirm_title)
            .setMessage(R.string.ui_pair_confirm_message)
            .setNegativeButton(R.string.ui_action_cancel, null)
            .setPositiveButton(R.string.ui_action_allow, (dialog, which) -> {
                getSharedPreferences("bridge", MODE_PRIVATE).edit()
                    .putString("secret", value).putBoolean("enabled", true).apply();
                secret.setText("");
                if (revealed) toggleSecret();
                clearClipboardIfMatches(value);
                ComputerUseService.reload();
                refresh();
                toast(R.string.ui_toast_paired);
            }).show();
    }

    /** The pairing command copies the secret to the clipboard; drop it once it is stored on both sides. */
    private void clearClipboardIfMatches(String value) {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData clip = clipboard == null ? null : clipboard.getPrimaryClip();
        CharSequence current = clip == null || clip.getItemCount() == 0 ? null : clip.getItemAt(0).coerceToText(this);
        if (current == null || !value.equals(current.toString().trim())) return;
        clipboard.setPrimaryClip(ClipData.newPlainText("", ""));
    }

    private void pause() {
        getSharedPreferences("bridge", MODE_PRIVATE).edit().putBoolean("enabled", false).apply();
        ComputerUseService.reload();
        refresh();
        toast(R.string.ui_toast_paused);
    }

    private void resume() {
        if (!hasSecret()) { toast(R.string.ui_toast_no_secret); return; }
        getSharedPreferences("bridge", MODE_PRIVATE).edit().putBoolean("enabled", true).apply();
        ComputerUseService.reload();
        refresh();
        toast(R.string.ui_toast_resumed);
    }

    private void confirmRevoke() {
        new AlertDialog.Builder(this)
            .setTitle(R.string.ui_revoke_title)
            .setMessage(R.string.ui_revoke_message)
            .setNegativeButton(R.string.ui_action_cancel, null)
            .setPositiveButton(R.string.ui_action_confirm_revoke, (dialog, which) -> {
                getSharedPreferences("bridge", MODE_PRIVATE).edit().clear().apply();
                ComputerUseService.reload();
                refresh();
                toast(R.string.ui_toast_revoked);
            }).show();
    }

    private boolean hasSecret() {
        return Auth.validSecret(getSharedPreferences("bridge", MODE_PRIVATE).getString("secret", ""));
    }

    private void refresh() {
        if (serviceValue == null) return;
        boolean connected = ComputerUseService.connected();
        boolean paired = hasSecret();
        boolean enabled = paired && getSharedPreferences("bridge", MODE_PRIVATE).getBoolean("enabled", false);
        serviceValue.setText(connected ? R.string.ui_service_connected : R.string.ui_service_off);
        serviceValue.setTextColor(color(connected ? R.color.ok : R.color.danger));
        controlValue.setText(enabled ? R.string.ui_control_enabled : paired ? R.string.ui_control_paused : R.string.ui_control_unpaired);
        controlValue.setTextColor(color(enabled ? R.color.ok : paired ? R.color.warn : R.color.text_secondary));
        serviceNote.setText(ComputerUseService.status());
        statusDot.setBackground(Ui.dot(color(!connected ? R.color.danger : enabled ? R.color.ok : R.color.warn)));
        setAvailability(pauseButton, enabled);
        setAvailability(resumeButton, !enabled && paired);
        setAvailability(revokeButton, paired);
    }

    private void setAvailability(Button button, boolean available) {
        button.setEnabled(available);
        button.setAlpha(available ? 1f : 0.45f);
    }

    private LinearLayout card() { return Ui.card(this); }

    private TextView section(int res) { return Ui.section(this, res); }

    private TextView text(CharSequence value, float sizeSp, int colorRes, boolean bold) {
        return Ui.text(this, value, sizeSp, colorRes, bold);
    }

    private Button filledButton(String label, Runnable action) {
        return button(label, action, R.color.accent, R.color.on_accent, accentRipple(), 52, 12, 16);
    }

    private Button softButton(String label, Runnable action) {
        return button(label, action, R.color.surface_alt, R.color.text_primary, neutralRipple(), 52, 12, 16);
    }

    private Button dangerButton(String label, Runnable action) {
        return button(label, action, R.color.danger_container, R.color.danger, dangerRipple(), 52, 12, 16);
    }

    private Button chip(String label, Runnable action) {
        Button button = button(label, action, R.color.surface_alt, R.color.accent, neutralRipple(), 46, 12, 13);
        button.setPadding(dp(12), 0, dp(12), 0);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        return button;
    }

    /** One button geometry for the whole page: same radius, no elevation, ripple feedback. */
    private Button button(String label, Runnable action, int backgroundRes, int textRes, int rippleColor, int heightDp, int radiusDp, float textSp) {
        Button button = Ui.button(this, label, backgroundRes, textRes, rippleColor, heightDp, radiusDp, textSp);
        button.setOnClickListener(view -> action.run());
        return button;
    }

    private int accentRipple() { return alpha(color(R.color.on_accent), 0x33); }
    private int neutralRipple() { return alpha(color(R.color.text_primary), 0x1F); }
    private int dangerRipple() { return alpha(color(R.color.danger), 0x26); }

    private int alpha(int rgb, int value) { return Ui.withAlpha(rgb, value); }

    private LinearLayout.LayoutParams top(int dp) { return Ui.top(this, dp); }

    private int color(int res) { return Ui.color(this, res); }

    private int dp(int value) { return Ui.dp(this, value); }

    private void toast(int res) {
        Toast.makeText(this, res, Toast.LENGTH_SHORT).show();
    }
}
