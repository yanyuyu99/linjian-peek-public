package dev.linjian.peek;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Encrypted migration layer for moving long-lived local data from the old public
 * package to the new private package. Runtime caches and Android permission state
 * are deliberately excluded.
 */
public final class MigrationState {
    private static final String FORMAT = "linjian-private-migration";
    private static final int VERSION = 1;
    private static final String[] PREF_NAMES = new String[] {
            AppPrefs.PREFS,
            "linjian_wallet_v1",
            "linjian_takeout_v1"
    };

    private MigrationState() { }

    public static String generateMigrationCode() {
        return MigrationCrypto.generateCode();
    }

    public static String exportEncrypted(Context ctx, char[] passphrase) throws Exception {
        JSONObject payload = new JSONObject();
        payload.put("format", FORMAT);
        payload.put("version", VERSION);
        payload.put("created_at_ms", System.currentTimeMillis());
        payload.put("source_package", ctx.getPackageName());
        payload.put("source_version", AppPrefs.APP_VERSION_NAME);

        JSONObject prefs = new JSONObject();
        for (String name : PREF_NAMES) {
            SharedPreferences source = ctx.getSharedPreferences(name, Context.MODE_PRIVATE);
            JSONObject one = new JSONObject();
            for (Map.Entry<String, ?> entry : source.getAll().entrySet()) {
                String key = entry.getKey();
                if (shouldSkip(name, key)) continue;
                Object value = entry.getValue();
                if (AppPrefs.PREFS.equals(name) && DiaryState.KEY_BOOKS.equals(key) && value instanceof String) {
                    value = sanitizeDiaryBooks((String)value);
                }
                JSONObject encoded = encodeValue(value);
                if (encoded != null) one.put(key, encoded);
            }
            prefs.put(name, one);
        }
        payload.put("preferences", prefs);
        payload.put("summary", summary(ctx));
        return MigrationCrypto.encrypt(payload.toString(), passphrase);
    }

    public static JSONObject importEncrypted(Context ctx, String envelope, char[] passphrase) throws Exception {
        String plaintext = MigrationCrypto.decrypt(envelope, passphrase);
        JSONObject payload = new JSONObject(plaintext);
        if (!FORMAT.equals(payload.optString("format"))) throw new IllegalArgumentException("invalid_migration_format");
        if (payload.optInt("version", 0) != VERSION) throw new IllegalArgumentException("unsupported_migration_version");

        JSONObject prefs = payload.optJSONObject("preferences");
        if (prefs == null) throw new IllegalArgumentException("missing_preferences");

        JSONObject diaryBundle = new JSONObject();
        JSONArray diaryBooks = null;
        JSONArray diaryEntries = null;
        JSONArray diaryAnnotations = null;

        JSONObject main = prefs.optJSONObject(AppPrefs.PREFS);
        if (main != null) {
            diaryBooks = jsonArrayFromTyped(main.optJSONObject(DiaryState.KEY_BOOKS));
            diaryEntries = jsonArrayFromTyped(main.optJSONObject(DiaryState.KEY_ENTRIES));
            diaryAnnotations = jsonArrayFromTyped(main.optJSONObject(DiaryState.KEY_ANNOTATIONS));
        }

        ArrayList<String> committed = new ArrayList<>();
        for (String name : PREF_NAMES) {
            JSONObject one = prefs.optJSONObject(name);
            if (one == null) continue;
            SharedPreferences.Editor editor = ctx.getSharedPreferences(name, Context.MODE_PRIVATE).edit();
            JSONArray names = one.names();
            if (names == null) continue;
            for (int i = 0; i < names.length(); i++) {
                String key = names.optString(i);
                if (AppPrefs.PREFS.equals(name) && isDiaryKey(key)) continue;
                if (shouldSkip(name, key)) continue;
                JSONObject encoded = one.optJSONObject(key);
                if (encoded != null) applyValue(editor, key, encoded);
            }
            if (!editor.commit()) throw new IllegalStateException("preferences_commit_failed:" + name);
            committed.add(name);
        }

        if (diaryBooks != null && diaryEntries != null) {
            diaryBundle.put("books", diaryBooks);
            diaryBundle.put("entries", diaryEntries);
            diaryBundle.put("annotations", diaryAnnotations == null ? new JSONArray() : diaryAnnotations);
            JSONObject imported = DiaryState.importBundle(ctx, diaryBundle.toString());
            if (!imported.optBoolean("ok", false)) throw new IllegalStateException("diary_import_failed");
        }

        JSONObject out = new JSONObject();
        out.put("ok", true);
        out.put("source_package", payload.optString("source_package", ""));
        out.put("source_version", payload.optString("source_version", ""));
        out.put("imported_namespaces", new JSONArray(committed));
        out.put("summary", summary(ctx));
        return out;
    }

    public static JSONObject summary(Context ctx) {
        JSONObject out = new JSONObject();
        try {
            out.put("diary_books", DiaryState.books(ctx).length());
            out.put("diary_entries", DiaryState.entries(ctx).length());
            out.put("diary_annotations", DiaryState.annotations(ctx).length());
            out.put("wallet_records", WalletState.records(ctx).length());
            JSONObject takeout = TakeoutState.collect(ctx);
            JSONArray cards = takeout.optJSONArray("cards");
            if (cards != null) out.put("takeout_cards", cards.length());
            JSONArray calendar = CalendarState.events(ctx);
            if (calendar != null) out.put("calendar_events", calendar.length());
        } catch (Exception ignored) { }
        return out;
    }

    private static boolean isDiaryKey(String key) {
        return DiaryState.KEY_BOOKS.equals(key) || DiaryState.KEY_ENTRIES.equals(key) || DiaryState.KEY_ANNOTATIONS.equals(key);
    }

    private static boolean shouldSkip(String namespace, String key) {
        if (key == null || key.isEmpty()) return true;

        if (AppPrefs.PREFS.equals(namespace)) {
            if ("debug_text".equals(key) || "a11y_settings_opened_at".equals(key) || "user_stopped".equals(key)) return true;
            if (GuidianState.KEY_AVATAR_URI.equals(key)) return true;
            if (CompanionWindowState.KEY_CACHE.equals(key) || CompanionWindowState.KEY_JOURNEY.equals(key) || CompanionWindowState.KEY_JOURNEY_DAY.equals(key)) return true;
            if (FocusMode.KEY_STATE.equals(key) || AppGate.KEY_STATE.equals(key)) return true;
            if ("home_mode_current_pkg".equals(key) || "home_mode_current_start_ms".equals(key) || "home_mode_last_fire_ms".equals(key)) return true;
            if ("weather_live_city".equals(key) || "weather_live_json".equals(key) || "weather_live_at".equals(key)) return true;
            if (key.startsWith("active_reminder_")) return true;
            if (key.startsWith("guidian_last_") || "guidian_today_date".equals(key) || "guidian_today_count".equals(key) || "guidian_due_but_not_shown".equals(key)) return true;
        }

        if ("linjian_takeout_v1".equals(namespace)) {
            if ("last_plan_json".equals(key) || "checkout_session_json".equals(key)) return true;
        }

        return false;
    }

    private static String sanitizeDiaryBooks(String raw) {
        try {
            JSONArray books = new JSONArray(raw);
            for (int i = 0; i < books.length(); i++) {
                JSONObject book = books.optJSONObject(i);
                if (book != null) book.put("cover_uri", "");
            }
            return books.toString();
        } catch (Exception ignored) {
            return raw;
        }
    }

    private static JSONObject encodeValue(Object value) throws Exception {
        if (value == null) return null;
        JSONObject out = new JSONObject();
        if (value instanceof String) return out.put("type", "string").put("value", value);
        if (value instanceof Boolean) return out.put("type", "boolean").put("value", value);
        if (value instanceof Integer) return out.put("type", "int").put("value", value);
        if (value instanceof Long) return out.put("type", "long").put("value", value);
        if (value instanceof Float) return out.put("type", "float").put("value", ((Float)value).doubleValue());
        if (value instanceof Set) {
            JSONArray arr = new JSONArray();
            for (Object item : (Set<?>)value) if (item instanceof String) arr.put(item);
            return out.put("type", "string_set").put("value", arr);
        }
        return null;
    }

    private static void applyValue(SharedPreferences.Editor editor, String key, JSONObject encoded) {
        String type = encoded.optString("type", "");
        if ("string".equals(type)) editor.putString(key, encoded.optString("value", ""));
        else if ("boolean".equals(type)) editor.putBoolean(key, encoded.optBoolean("value", false));
        else if ("int".equals(type)) editor.putInt(key, encoded.optInt("value", 0));
        else if ("long".equals(type)) editor.putLong(key, encoded.optLong("value", 0L));
        else if ("float".equals(type)) editor.putFloat(key, (float)encoded.optDouble("value", 0d));
        else if ("string_set".equals(type)) {
            JSONArray arr = encoded.optJSONArray("value");
            HashSet<String> set = new HashSet<>();
            if (arr != null) for (int i = 0; i < arr.length(); i++) set.add(arr.optString(i));
            editor.putStringSet(key, set);
        }
    }

    private static JSONArray jsonArrayFromTyped(JSONObject encoded) {
        if (encoded == null || !"string".equals(encoded.optString("type"))) return null;
        try { return new JSONArray(encoded.optString("value", "[]")); }
        catch (Exception ignored) { return null; }
    }
}
