package dev.picomputeruse;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.LongSupplier;

/** Caller stores detached immutable values, never live AccessibilityNodeInfo objects. */
public final class SnapshotStore<T> {
    private static final class Entry<T> {
        final T value;
        final long created;
        final long epoch;
        Entry(T value, long created, long epoch) { this.value = value; this.created = created; this.epoch = epoch; }
    }
    private final LinkedHashMap<String, Entry<T>> entries = new LinkedHashMap<>();
    private final String generation = UUID.randomUUID().toString();
    private final int limit;
    private final long ttl;
    private final LongSupplier clock;
    private long nextId;
    private long epoch;

    public SnapshotStore(int limit, long ttl, LongSupplier clock) {
        if (limit < 1 || ttl < 1 || clock == null) throw new IllegalArgumentException("Invalid store bounds");
        this.limit = limit;
        this.ttl = ttl;
        this.clock = clock;
    }

    public synchronized String put(T value) {
        String id = generation + ":" + (++nextId);
        entries.put(id, new Entry<>(value, clock.getAsLong(), epoch));
        while (entries.size() > limit) entries.remove(entries.keySet().iterator().next());
        return id;
    }

    private Entry<T> entry(String id) {
        Entry<T> entry = entries.get(id);
        if (entry == null || clock.getAsLong() - entry.created >= ttl) {
            entries.remove(id);
            throw new IllegalStateException("stale_state: observe the window again");
        }
        return entry;
    }

    public synchronized T get(String id) { return entry(id).value; }

    public synchronized T requireWritable(String id) {
        Entry<T> entry = entry(id);
        if (entry.epoch != epoch) throw new IllegalStateException("stale_state: another action changed the device");
        return entry.value;
    }

    public synchronized void invalidateWrites() { epoch++; }
    public synchronized void clear() { entries.clear(); epoch++; }
}
