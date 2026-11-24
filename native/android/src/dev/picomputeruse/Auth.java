package dev.picomputeruse;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Mutual HMAC authentication; never transmit the stored secret on connection. */
public final class Auth {
    private static final SecureRandom RANDOM = new SecureRandom();
    private Auth() {}

    public static boolean validSecret(String value) {
        return value != null && value.matches("[0-9a-f]{64}");
    }

    public static String randomHex() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return hex(bytes);
    }

    public static String proof(String secret, String role, String nonce) {
        if (!validSecret(secret) || !validSecret(nonce) || !(role.equals("server") || role.equals("client"))) {
            throw new IllegalArgumentException("Invalid authentication parameters");
        }
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.US_ASCII), "HmacSHA256"));
            return hex(mac.doFinal(("pi-cu-android-v1:" + role + ":" + nonce).getBytes(StandardCharsets.US_ASCII)));
        } catch (java.security.GeneralSecurityException error) {
            throw new IllegalStateException("HMAC unavailable", error);
        }
    }

    public static boolean verify(String secret, String role, String nonce, String candidate) {
        if (!validSecret(secret) || !validSecret(nonce) || !validSecret(candidate)) return false;
        return MessageDigest.isEqual(proof(secret, role, nonce).getBytes(StandardCharsets.US_ASCII), candidate.getBytes(StandardCharsets.US_ASCII));
    }

    private static String hex(byte[] bytes) {
        char[] chars = new char[bytes.length * 2];
        char[] digits = "0123456789abcdef".toCharArray();
        for (int i = 0; i < bytes.length; i++) {
            chars[i * 2] = digits[(bytes[i] & 255) >>> 4];
            chars[i * 2 + 1] = digits[bytes[i] & 15];
        }
        return new String(chars);
    }
}
