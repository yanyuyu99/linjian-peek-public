package dev.linjian.peek;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/** Pure-Java crypto envelope used by the public->private app migration. */
public final class MigrationCrypto {
    private static final String PREFIX = "LINJIAN-MIGRATION-1";
    private static final int ITERATIONS = 210_000;
    private static final int KEY_BITS = 256;
    private static final int SALT_BYTES = 16;
    private static final int IV_BYTES = 12;
    private static final int GCM_TAG_BITS = 128;
    private static final String CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

    private MigrationCrypto() { }

    public static String generateCode() {
        SecureRandom random = new SecureRandom();
        StringBuilder out = new StringBuilder(20);
        for (int i = 0; i < 20; i++) out.append(CODE_ALPHABET.charAt(random.nextInt(CODE_ALPHABET.length())));
        return out.toString();
    }

    public static String encrypt(String plaintext, char[] passphrase) throws Exception {
        validatePassphrase(passphrase);
        SecureRandom random = new SecureRandom();
        byte[] salt = new byte[SALT_BYTES];
        byte[] iv = new byte[IV_BYTES];
        random.nextBytes(salt);
        random.nextBytes(iv);

        SecretKeySpec key = derive(passphrase, salt, ITERATIONS);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
        cipher.updateAAD(PREFIX.getBytes(StandardCharsets.UTF_8));
        byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));

        return PREFIX + "." + ITERATIONS + "." + hex(salt) + "." + hex(iv) + "." + hex(ciphertext);
    }

    public static String decrypt(String envelope, char[] passphrase) throws Exception {
        validatePassphrase(passphrase);
        String[] parts = envelope == null ? new String[0] : envelope.trim().split("\\.", 5);
        if (parts.length != 5 || !PREFIX.equals(parts[0])) throw new IllegalArgumentException("invalid_migration_envelope");

        int iterations = Integer.parseInt(parts[1]);
        if (iterations < 100_000 || iterations > 1_000_000) throw new IllegalArgumentException("invalid_kdf_iterations");

        byte[] salt = unhex(parts[2]);
        byte[] iv = unhex(parts[3]);
        byte[] ciphertext = unhex(parts[4]);
        if (salt.length != SALT_BYTES || iv.length != IV_BYTES || ciphertext.length < 16) throw new IllegalArgumentException("invalid_migration_envelope");

        SecretKeySpec key = derive(passphrase, salt, iterations);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
        cipher.updateAAD(PREFIX.getBytes(StandardCharsets.UTF_8));
        byte[] plaintext = cipher.doFinal(ciphertext);
        return new String(plaintext, StandardCharsets.UTF_8);
    }

    private static SecretKeySpec derive(char[] passphrase, byte[] salt, int iterations) throws Exception {
        PBEKeySpec spec = new PBEKeySpec(passphrase, salt, iterations, KEY_BITS);
        try {
            byte[] key = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
            return new SecretKeySpec(key, "AES");
        } finally {
            spec.clearPassword();
        }
    }

    private static void validatePassphrase(char[] passphrase) {
        if (passphrase == null || passphrase.length < 12) throw new IllegalArgumentException("migration_code_too_short");
    }

    private static String hex(byte[] bytes) {
        char[] out = new char[bytes.length * 2];
        char[] alphabet = "0123456789abcdef".toCharArray();
        for (int i = 0; i < bytes.length; i++) {
            int v = bytes[i] & 0xff;
            out[i * 2] = alphabet[v >>> 4];
            out[i * 2 + 1] = alphabet[v & 0x0f];
        }
        return new String(out);
    }

    private static byte[] unhex(String value) {
        if (value == null || (value.length() & 1) != 0) throw new IllegalArgumentException("invalid_hex");
        byte[] out = new byte[value.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int hi = Character.digit(value.charAt(i * 2), 16);
            int lo = Character.digit(value.charAt(i * 2 + 1), 16);
            if (hi < 0 || lo < 0) throw new IllegalArgumentException("invalid_hex");
            out[i] = (byte)((hi << 4) | lo);
        }
        return out;
    }
}
