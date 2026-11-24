package dev.picomputeruse;

import java.util.concurrent.atomic.AtomicLong;

/** Pure JVM tests: no Android runtime or external test dependency. */
public final class CoreTest {
    static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
    static void rejects(Runnable work, String message) {
        try { work.run(); } catch (IllegalArgumentException | IllegalStateException expected) { return; }
        throw new AssertionError(message);
    }
    public static void main(String[] args) {
        String secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        check(Auth.validSecret(secret), "valid 256-bit secret");
        check(!Auth.validSecret(""), "empty secret rejected");
        check(!Auth.validSecret(secret + "0"), "wrong length rejected");
        check(!Auth.validSecret(secret.replace('a', 'z')), "non-hex secret rejected");
        String nonce = Auth.randomHex();
        check(nonce.length() == 64 && !nonce.equals(Auth.randomHex()), "fresh nonce");
        String proof = Auth.proof(secret, "client", nonce);
        check(Auth.verify(secret, "client", nonce, proof), "correct proof");
        check(!Auth.verify(secret, "server", nonce, proof), "role separation");
        check(!Auth.verify(secret, "client", Auth.randomHex(), proof), "nonce binding");
        check(!Auth.verify(secret, "client", nonce, "bad"), "malformed proof");
        check(!Auth.verify("", "client", nonce, proof), "unpaired fail closed");

        AtomicLong clock = new AtomicLong(100);
        SnapshotStore<String> store = new SnapshotStore<>(2, 1000, clock::get);
        String a = store.put("first");
        String b = store.put("second");
        check(store.get(a).equals("first"), "read does not mutate");
        String c = store.put("third");
        rejects(() -> store.get(a), "oldest observation evicted");
        check(store.get(b).equals("second"), "second observation retained");
        store.invalidateWrites();
        rejects(() -> store.requireWritable(b), "mutation invalidates old observations");
        check(store.get(b).equals("second"), "historical read still available");
        String d = store.put("fresh");
        check(store.requireWritable(d).equals("fresh"), "fresh state writable");
        clock.set(1101);
        rejects(() -> store.get(d), "expired state rejected");
        store.clear();
        rejects(() -> store.get(c), "clear revokes all states");
        rejects(() -> store.get(null), "null id rejected");
        SnapshotStore<String> other = new SnapshotStore<>(2, 1000, clock::get);
        check(!other.put("fresh").equals(d), "session generation prevents identity reuse");
        System.out.println("Android core checks passed (auth, expiry, eviction, stale writes, generations).");
    }
}
