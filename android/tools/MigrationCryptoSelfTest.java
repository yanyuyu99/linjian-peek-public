import dev.linjian.peek.MigrationCrypto;

public final class MigrationCryptoSelfTest {
    public static void main(String[] args) throws Exception {
        char[] code = "Abcdef23456789XYZghi".toCharArray();
        String original = "{\"format\":\"linjian-private-migration\",\"version\":1,\"marker\":\"TEST_ONLY\"}";
        String encrypted = MigrationCrypto.encrypt(original, code);
        if (encrypted.contains("TEST_ONLY")) throw new IllegalStateException("plaintext_leaked");
        String decrypted = MigrationCrypto.decrypt(encrypted, code);
        if (!original.equals(decrypted)) throw new IllegalStateException("roundtrip_failed");
        boolean wrongCodeRejected = false;
        try { MigrationCrypto.decrypt(encrypted, "WrongCode23456789XYZ".toCharArray()); }
        catch (Exception expected) { wrongCodeRejected = true; }
        if (!wrongCodeRejected) throw new IllegalStateException("wrong_code_accepted");
        System.out.println("MIGRATION_CRYPTO_SELFTEST_OK");
    }
}
