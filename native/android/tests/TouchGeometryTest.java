package dev.picomputeruse;

/** Pure JVM regression for occlusion along the whole gesture, not the whole app window. */
public final class TouchGeometryTest {
    private static float[][] path(float... xy) {
        float[][] points = new float[xy.length / 2][2];
        for (int i = 0; i < points.length; i++) { points[i][0] = xy[i*2]; points[i][1] = xy[i*2+1]; }
        return points;
    }
    private static void expect(boolean expected, float[][] points, double l, double t, double r, double b, String message) {
        if (TouchGeometry.intersects(points, l, t, r, b) != expected) throw new AssertionError(message);
    }
    private static void invalid(Runnable work) {
        try { work.run(); } catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("Malformed geometry must fail closed");
    }
    public static void main(String[] args) {
        expect(false,path(540,600),0,0,1080,101,"Status bar must not block a clear content tap");
        expect(false,path(540,600),899,1194,1124,1521,"Unrelated floating window must not block a clear tap");
        expect(true,path(540,80),0,0,1080,101,"Status-bar tap must be blocked");
        expect(true,path(950,1300),899,1194,1124,1521,"Floating-window tap must be blocked");
        expect(true,path(0,50,100,50),40,40,60,60,"Segment crossing must be blocked even with both endpoints outside");
        expect(true,path(100,50,0,50),40,40,60,60,"Reverse crossing");
        expect(true,path(50,0,50,100),40,40,60,60,"Vertical crossing");
        expect(false,path(20,0,20,100),40,40,60,60,"Parallel segment outside");
        expect(false,path(0,20,100,20),40,40,60,60,"Horizontal segment outside");
        expect(true,path(0,0,100,100),40,40,60,60,"Diagonal crossing");
        expect(false,path(0,0,100,100),10,70,30,90,"Overlapping bounding boxes alone do not prove occlusion");
        expect(true,path(0,0,100,0,100,100),90,40,110,60,"Check every segment");
        expect(true,path(40,50),40,40,60,60,"Closed rectangle edge");
        expect(true,path(60,60),40,40,60,60,"Closed rectangle corner");
        expect(true,path(39.5f,50),40,40,60,60,"One-pixel safety margin");
        expect(false,path(38,50),40,40,60,60,"Outside safety margin");
        expect(false,path(50,50),40,40,40,60,"Empty window does not occlude");
        expect(true,path(50,50,50,50),40,40,60,60,"Zero-length segment inside");
        invalid(() -> TouchGeometry.intersects(null,0,0,10,10));
        invalid(() -> TouchGeometry.intersects(new float[0][],0,0,10,10));
        invalid(() -> TouchGeometry.intersects(new float[][]{{1}},0,0,10,10));
        invalid(() -> TouchGeometry.intersects(path(Float.NaN,1),0,0,10,10));
        invalid(() -> TouchGeometry.intersects(path(1,1),0,0,Double.POSITIVE_INFINITY,10));
        invalid(() -> TouchGeometry.intersects(path(1,1),10,0,0,10));
        System.out.println("Touch geometry checks passed (24 cases: bars, overlays, segments, edges, malformed input).");
    }
}
