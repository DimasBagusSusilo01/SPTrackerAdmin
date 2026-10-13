/**
 * ==============================================================================
 * ESP32 / Arduino Firmware: Automatic Solar Tracker Telemetry to Supabase
 * ==============================================================================
 * CARA KERJA:
 * Begitu perangkat ESP32 dinyalakan (power ON), alat ini akan:
 * 1. Otomatis terhubung ke jaringan Wi-Fi.
 * 2. Membaca sensor fisik (Tegangan, Arus, Daya, Iradiasi matahari, dan Sudut servo).
 * 3. Otomatis mengirim data ke database Supabase via HTTP POST REST API.
 * 4. Berulang secara berkala (misal setiap 5 atau 10 detik) tanpa perlu campur tangan manual!
 * 
 * LIBRARI ARDUINO YANG DIBUTUHKAN:
 * - WiFi.h (bawaan board ESP32)
 * - HTTPClient.h (bawaan board ESP32)
 * - ArduinoJson.h (instal via Library Manager: versi 6 atau 7)
 * - (Opsional sensor): Adafruit_INA219.h, Wire.h
 * ==============================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <time.h>

// ==============================================================================
// 1. PENGATURAN WI-FI & KREDENSIAL SUPABASE
// ==============================================================================
const char* WIFI_SSID     = "NAMA_WIFI_ANDA";     // Ganti dengan nama WiFi / Hotspot HP
const char* WIFI_PASSWORD = "PASSWORD_WIFI";      // Ganti dengan password WiFi

// URL Endpoint Supabase REST API untuk tabel 'solar_telemetry'
const char* SUPABASE_REST_URL = "https://cnitfsuiskyxhmcpwgsa.supabase.co/rest/v1/solar_telemetry";

// Kunci Supabase Anon Public Key
const char* SUPABASE_API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNuaXRmc3Vpc2t5eGhtY3B3Z3NhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3Mjk0MzAsImV4cCI6MjEwNjMwNTQzMH0.Y70BsCBB9X6fs7SFfAVfmoniHQKF9l43eoLBJ6Gss9g";

// ID Perangkat
const char* DEVICE_ID = "ESP32-SOLAR-01";

// Interval pengiriman data (dalam milidetik: 5000 ms = 5 detik)
const unsigned long SEND_INTERVAL_MS = 5000;
unsigned long lastSendTime = 0;

// Akumulasi energi listrik (kWh)
float totalEnergiKWh = 0.0;
unsigned long lastEnergyCalcTime = 0;

// NTP Server untuk sinkronisasi waktu dan tanggal otomatis
const char* NTP_SERVER = "pool.ntp.org";
const long  GMT_OFFSET_SEC = 7 * 3600; // GMT+7 untuk Waktu Indonesia Barat (WIB)
const int   DAYLIGHT_OFFSET_SEC = 0;

// ==============================================================================
// 2. FUNGSI INISIALISASI WAKTU (NTP)
// ==============================================================================
void setupTime() {
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);
  Serial.print("[WAKTU] Menyelaraskan waktu via NTP...");
  struct tm timeinfo;
  int retry = 0;
  while (!getLocalTime(&timeinfo) && retry < 10) {
    delay(500);
    Serial.print(".");
    retry++;
  }
  if (retry < 10) {
    Serial.println("\n[WAKTU] Berhasil sinkronisasi waktu!");
  } else {
    Serial.println("\n[WAKTU] Gagal NTP (akan menggunakan estimasi default)");
  }
}

void getFormattedDateTime(char* dateStr, size_t dateSize, char* timeStr, size_t timeSize) {
  struct tm timeinfo;
  if (getLocalTime(&timeinfo)) {
    strftime(dateStr, dateSize, "%Y-%m-%d", &timeinfo);
    strftime(timeStr, timeSize, "%H:%M:%S", &timeinfo);
  } else {
    // Fallback jika belum dapat sinyal NTP
    snprintf(dateStr, dateSize, "2026-10-11");
    snprintf(timeStr, timeSize, "12:00:00");
  }
}

// ==============================================================================
// 3. FUNGSI MEMBACA SENSOR (Dapat dihubungkan ke sensor asli Anda)
// ==============================================================================
struct SolarSensors {
  float voltase;      // V
  float arusListrik;  // A
  float daya;         // W
  float energi;       // kWh
  float irradiansi;   // W/m²
  float besarSudut;   // Derajat (°)
};

SolarSensors readSolarSensors() {
  SolarSensors data;

  // JIKA MENGGUNAKAN SENSOR FISIK ASLI:
  // - Sensor Tegangan & Arus: INA219 (I2C) atau sensor ZMPT101B / ACS712
  // - Sensor Iradiasi: Pyranometer analog atau LDR sensor cahaya (ADC)
  // - Sensor Sudut: Potensiometer pada engsel servo / MPU6050 Accelerometer
  
  // Contoh pembacaan nyata / simulasi jika sensor belum dicolok:
  // Voltase berkisar 370V - 410V (atau sesuaikan dengan panel mini 12V - 24V)
  data.voltase = 380.0 + ((float)random(-100, 100) / 10.0);
  data.arusListrik = 12.0 + ((float)random(-80, 80) / 100.0);
  data.daya = data.voltase * data.arusListrik; // Daya (W) = V * I

  // Iradiasi berkisar 800 - 950 W/m²
  data.irradiansi = 850.0 + (float)random(-50, 70);

  // Besar sudut pelacak (misal kemiringan panel 0° - 90°)
  data.besarSudut = 34.5 + ((float)random(-20, 20) / 10.0);

  // Hitung akumulasi energi: kWh += (Watt * detik / 3600) / 1000
  unsigned long now = millis();
  if (lastEnergyCalcTime > 0) {
    float dtHours = (float)(now - lastEnergyCalcTime) / 3600000.0;
    totalEnergiKWh += (data.daya * dtHours) / 1000.0;
  }
  lastEnergyCalcTime = now;
  data.energi = totalEnergiKWh > 0 ? totalEnergiKWh : 34.85;

  return data;
}

// ==============================================================================
// 4. FUNGSI KIRIM DATA OTOMATIS KE SUPABASE
// ==============================================================================
bool sendDataToSupabase(SolarSensors s) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[ERROR] Wi-Fi terputus! Mencoba menyambung kembali...");
    WiFi.reconnect();
    return false;
  }

  char dateStr[16];
  char timeStr[16];
  getFormattedDateTime(dateStr, sizeof(dateStr), timeStr, sizeof(timeStr));

  HTTPClient http;
  http.begin(SUPABASE_REST_URL);

  // Header wajib untuk akses Supabase REST API
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_API_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_API_KEY);
  http.addHeader("Prefer", "return=minimal"); // Menghemat bandwidth mikrokontroler

  // Buat Payload JSON
  StaticJsonDocument<300> doc;
  doc["waktu_tanggal"]  = dateStr;
  doc["waktu_jam"]      = timeStr;
  doc["voltase"]        = serialized(String(s.voltase, 2));
  doc["arus_listrik"]   = serialized(String(s.arusListrik, 2));
  doc["daya"]           = serialized(String(s.daya, 2));
  doc["energi_listrik"] = serialized(String(s.energi, 2));
  doc["irradiansi"]     = serialized(String(s.irradiansi, 1));
  doc["besar_sudut"]    = serialized(String(s.besarSudut, 1));
  doc["device_id"]      = DEVICE_ID;
  doc["sumber"]         = "esp32_iot";

  String requestBody;
  serializeJson(doc, requestBody);

  Serial.println("[SUPABASE] Mengirim telemetri...");
  Serial.println(requestBody);

  int httpResponseCode = http.POST(requestBody);

  if (httpResponseCode >= 200 && httpResponseCode < 300) {
    Serial.printf(">>> [BERHASIL] Data terkirim ke Supabase! Status: %d\n", httpResponseCode);
    http.end();
    return true;
  } else {
    Serial.printf(">>> [GAGAL] HTTP Error: %d - %s\n", httpResponseCode, http.getString().c_str());
    http.end();
    return false;
  }
}

// ==============================================================================
// 5. SETUP & MAIN LOOP
// ==============================================================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n==================================================");
  Serial.println("  SOLAR TRACKER TELEMETRY DAEMON (ESP32)");
  Serial.println("  Auto-Send to Supabase Database");
  Serial.println("==================================================");

  // Hubungkan ke Wi-Fi
  Serial.printf("[WIFI] Menghubungkan ke %s ", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\n[WIFI] Terhubung!");
  Serial.print("[WIFI] IP Address: ");
  Serial.println(WiFi.localIP());

  // Sinkronisasi waktu jam & tanggal
  setupTime();

  lastSendTime = millis() - SEND_INTERVAL_MS; // Kirim paket pertama segera
}

void loop() {
  unsigned long currentMillis = millis();

  // Pengiriman berkala otomatis selama alat menyala
  if (currentMillis - lastSendTime >= SEND_INTERVAL_MS) {
    lastSendTime = currentMillis;

    // Baca sensor dan kirim
    SolarSensors sensors = readSolarSensors();
    sendDataToSupabase(sensors);
  }

  delay(50);
}
