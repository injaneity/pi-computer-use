package dev.picomputeruse;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Shared flat-surface styling for the companion's two pages: same radii, no elevation. */
final class Ui {
    private Ui() {}

    static int dp(Context context, float value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    static int color(Context context, int res) {
        return context.getResources().getColor(res, context.getTheme());
    }

    static int withAlpha(int rgb, int alpha) {
        return (rgb & 0x00FFFFFF) | ((alpha & 0xFF) << 24);
    }

    static GradientDrawable shape(int fill, int radiusPx, int strokePx, int strokeColor) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setShape(GradientDrawable.RECTANGLE);
        drawable.setColor(fill);
        drawable.setCornerRadius(radiusPx);
        if (strokePx > 0) drawable.setStroke(strokePx, strokeColor);
        return drawable;
    }

    static GradientDrawable dot(int fill) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setShape(GradientDrawable.OVAL);
        drawable.setColor(fill);
        return drawable;
    }

    static RippleDrawable ripple(int rippleColor, int fill, int radiusPx) {
        return new RippleDrawable(ColorStateList.valueOf(rippleColor), shape(fill, radiusPx, 0, 0), null);
    }

    static TextView text(Context context, CharSequence value, float sizeSp, int colorRes, boolean bold) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextSize(sizeSp);
        view.setTextColor(color(context, colorRes));
        if (bold) view.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        view.setLineSpacing(dp(context, 2), 1f);
        return view;
    }

    static LinearLayout card(Context context) {
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(context, 16), dp(context, 14), dp(context, 16), dp(context, 14));
        card.setBackground(shape(color(context, R.color.surface), dp(context, 16), dp(context, 1), color(context, R.color.border)));
        return card;
    }

    static TextView section(Context context, int titleRes) {
        TextView view = text(context, context.getString(titleRes), 12, R.color.text_secondary, true);
        view.setLetterSpacing(0.08f);
        return view;
    }

    static Button button(Context context, String label, int backgroundRes, int textRes, int rippleColor,
                         int heightDp, int radiusDp, float textSp) {
        Button button = new Button(context);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextSize(textSp);
        button.setTextColor(color(context, textRes));
        button.setGravity(Gravity.CENTER);
        button.setPadding(dp(context, 16), 0, dp(context, 16), 0);
        button.setMinHeight(dp(context, heightDp));
        button.setMinimumHeight(dp(context, heightDp));
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setElevation(0f);
        button.setStateListAnimator(null);
        button.setBackground(ripple(rippleColor, color(context, backgroundRes), dp(context, radiusDp)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(context, heightDp));
        button.setLayoutParams(params);
        return button;
    }

    static LinearLayout.LayoutParams top(Context context, int dp) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(context, dp);
        return params;
    }

    /** Edge-to-edge is mandatory from API 35, so pad by the real system bar and IME insets. */
    static void applyInsets(ScrollView scroll, LinearLayout content) {
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsets.Type.ime());
            int side = dp(content.getContext(), 20);
            content.setPadding(side, bars.top + dp(content.getContext(), 16), side,
                Math.max(bars.bottom, ime.bottom) + dp(content.getContext(), 24));
            return insets;
        });
        scroll.requestApplyInsets();
    }

    static ScrollView scrollPage(Context context, LinearLayout content) {
        ScrollView scroll = new ScrollView(context);
        scroll.setFillViewport(true);
        scroll.setClipToPadding(false);
        scroll.addView(content, new ScrollView.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return scroll;
    }

    static View spacer(Context context, int heightDp) {
        View view = new View(context);
        view.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(context, heightDp)));
        return view;
    }
}
