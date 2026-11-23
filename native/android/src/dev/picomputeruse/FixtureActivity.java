package dev.picomputeruse;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * Harmless local acceptance fixture: never sends data or persists user text.
 * Element ids and the marker title are part of the live test contract.
 */
public final class FixtureActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        ScrollView scroll = Ui.scrollPage(this, content);
        setContentView(scroll);
        Ui.applyInsets(scroll, content);

        content.addView(Ui.text(this, getString(R.string.fixture_title), 24, R.color.text_primary, true), Ui.top(this, 16));
        content.addView(Ui.text(this, getString(R.string.fixture_subtitle), 13, R.color.text_secondary, false), Ui.top(this, 4));

        content.addView(Ui.section(this, R.string.fixture_section_input), Ui.top(this, 24));
        LinearLayout inputCard = Ui.card(this);
        inputCard.addView(Ui.text(this, getString(R.string.fixture_input_label), 14, R.color.text_secondary, false));

        EditText input = new EditText(this);
        input.setId(R.id.fixture_input);
        input.setHint(R.string.fixture_input_hint);
        input.setSingleLine(true);
        input.setTextSize(16);
        input.setTextColor(Ui.color(this, R.color.text_primary));
        input.setHintTextColor(Ui.color(this, R.color.text_secondary));
        input.setInputType(InputType.TYPE_CLASS_TEXT);
        input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        input.setBackground(Ui.shape(Ui.color(this, R.color.surface_alt), Ui.dp(this, 12), 0, 0));
        input.setPadding(Ui.dp(this, 12), Ui.dp(this, 11), Ui.dp(this, 12), Ui.dp(this, 11));
        input.setMinHeight(Ui.dp(this, 46));
        input.setMinimumHeight(Ui.dp(this, 46));
        inputCard.addView(input, Ui.top(this, 10));

        Button save = Ui.button(this, getString(R.string.fixture_save), R.color.accent, R.color.on_accent,
            Ui.withAlpha(Ui.color(this, R.color.on_accent), 0x33), 52, 12, 16);
        save.setId(R.id.fixture_save);
        inputCard.addView(save, Ui.top(this, 12));

        LinearLayout resultRow = new LinearLayout(this);
        resultRow.setOrientation(LinearLayout.HORIZONTAL);
        resultRow.setGravity(Gravity.CENTER_VERTICAL);
        resultRow.addView(Ui.text(this, getString(R.string.fixture_result_label), 13, R.color.text_secondary, false),
            new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView result = Ui.text(this, getString(R.string.fixture_not_saved), 14, R.color.text_secondary, true);
        result.setId(R.id.fixture_result);
        resultRow.addView(result);
        inputCard.addView(resultRow, Ui.top(this, 12));
        content.addView(inputCard, Ui.top(this, 8));

        save.setOnClickListener(view -> {
            String text = input.getText().toString();
            boolean empty = text.trim().isEmpty();
            result.setText(empty ? getString(R.string.fixture_not_saved)
                : getString(R.string.fixture_saved, text));
            result.setTextColor(Ui.color(this, empty ? R.color.text_secondary : R.color.ok));
        });

        content.addView(Ui.section(this, R.string.fixture_section_dialog), Ui.top(this, 24));
        LinearLayout dialogCard = Ui.card(this);
        Button dialog = Ui.button(this, getString(R.string.fixture_dialog), R.color.surface_alt, R.color.text_primary,
            Ui.withAlpha(Ui.color(this, R.color.text_primary), 0x1F), 52, 12, 16);
        dialog.setOnClickListener(view -> new AlertDialog.Builder(this)
            .setTitle(R.string.fixture_dialog_title)
            .setMessage(R.string.fixture_dialog_message)
            .setPositiveButton(R.string.fixture_dialog_close, null)
            .show());
        dialogCard.addView(dialog);
        content.addView(dialogCard, Ui.top(this, 8));

        content.addView(Ui.section(this, R.string.fixture_section_scroll), Ui.top(this, 24));
        LinearLayout rows = Ui.card(this);
        int rowPadding = Ui.dp(this, 11);
        for (int index = 1; index <= 25; index++) {
            TextView row = Ui.text(this, getString(R.string.fixture_row, index), 16, R.color.text_primary, false);
            row.setPadding(0, rowPadding, 0, rowPadding);
            rows.addView(row);
            if (index < 25) {
                View divider = new View(this);
                divider.setBackgroundColor(Ui.color(this, R.color.border));
                rows.addView(divider, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, Ui.dp(this, 0.5f))));
            }
        }
        content.addView(rows, Ui.top(this, 8));
        content.addView(Ui.spacer(this, 8));
    }
}
