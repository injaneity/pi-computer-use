package dev.picomputeruse;

/** Pure screen-coordinate geometry for checking touch paths against overlay bounds. */
public final class TouchGeometry {
    private TouchGeometry() {}
    public static boolean intersects(float[][] points, double left, double top, double right, double bottom) {
        if (points == null || points.length == 0 || points.length > 100
            || !Double.isFinite(left) || !Double.isFinite(top) || !Double.isFinite(right) || !Double.isFinite(bottom)
            || right < left || bottom < top) throw new IllegalArgumentException("Invalid touch geometry");
        for (float[] point : points) {
            if (point == null || point.length != 2 || !Float.isFinite(point[0]) || !Float.isFinite(point[1]))
                throw new IllegalArgumentException("Invalid touch point");
        }
        if (left == right || top == bottom) return false;
        // Include a one-screen-pixel margin for coordinate rounding at overlay edges.
        double[] low = {left - 1, top - 1}, high = {right + 1, bottom + 1};
        for (int i = 0; i < points.length; i++) {
            float[] start = points[Math.max(0, i - 1)], end = points[i];
            double enter = 0, exit = 1;
            for (int axis = 0; axis < 2; axis++) {
                double delta = (double)end[axis] - start[axis];
                if (delta == 0) {
                    if (start[axis] < low[axis] || start[axis] > high[axis]) { enter = 1; exit = 0; break; }
                } else {
                    double a = (low[axis] - start[axis]) / delta;
                    double b = (high[axis] - start[axis]) / delta;
                    enter = Math.max(enter, Math.min(a, b));
                    exit = Math.min(exit, Math.max(a, b));
                }
            }
            if (enter <= exit) return true;
        }
        return false;
    }
}
