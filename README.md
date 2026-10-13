# HelioTrack Admin - Solar Panel Telemetry Hub & Supabase IoT Manager

Aplikasi web administrasi dan pusat kendali input data telemetri solar panel tracker. Dirancang dengan gaya **minimalis**, **tanpa login**, tema **dark emerald green** yang serasi dengan [solar-panel-tracker](../solar-panel-tracker/homepage.html), serta dilengkapi integrasi penuh ke database **Supabase** dan dukungan transmisi data otomatis dari mikrokontroler (ESP32 / Arduino / Python).

---

## Fitur Utama

### 1. Form Input Data 8 Parameter Lengkap
Formulir input data telemetri panel surya dengan kalkulasi otomatis dan dial visual:
- **Waktu Tanggal**: Format `YYYY-MM-DD` (tombol pintas *Hari Ini*).
- **Waktu Jam**: Format `HH:MM:SS` (tombol pintas *Sekarang*).
- **Voltase**: Tegangan listrik DC (Satuan: **V**, rentang 0 - 1000V).
- **Arus Listrik**: Arus beban panel (Satuan: **A**, rentang 0 - 100A).
- **Daya Listrik**: Daya keluaran (Satuan: **W** atau **kW**, opsi *Auto V × I* otomatis).
- **Energi Listrik**: Akumulasi produksi energi (Satuan: **kWh**).
- **Irradiansi**: Tingkat intensitas sinar matahari (Satuan: **W/m²**).
- **Besar Sudut**: Derajat kemiringan panel surya (Satuan: **°**, dilengkapi *interactive range slider* dan *mini dial indicator*).
- **Device Identifier & Tag Sumber**: Menandai alat pengirim (`ESP32-SOLAR-01`, `admin_web`, dll).

### 2. Integrasi Database Supabase
- Terhubung langsung ke Supabase REST API & Realtime WebSocket (`@supabase/supabase-js` v2).
- Dilengkapi **Pendeteksi Status Otomatis** (*Connected*, *Table Missing*, atau *Local Buffer*).
- Dilengkapi modal konfigurasi untuk mengubah URL & Anon Key Supabase tanpa menyentuh kode.
- **Offline / Local Buffer Fallback**: Jika internet padam atau tabel di Supabase belum sempat dibuat, data tetap aman tersimpan di penyimpanan lokal browser (LocalStorage) dan siap disinkronkan.

### 3. Pengiriman Otomatis Saat Perangkat Menyala (ESP32 / IoT / Python)
> **"Bisakah dibuat data yang masuk itu otomatis send ke database Supabase asalkan perangkat menyala saja?"**  
> **Jawabannya: BISA SEKALI!**

Kami telah menyediakan 3 cara pengiriman otomatis:
1. **Mikrokontroler ESP32 Mandiri (`esp32_firmware.ino`)**:
   - Begitu alat ESP32 diberi daya (power ON), alat otomatis tersambung ke Wi-Fi / Hotspot.
   - Membaca sensor (Voltase, Arus, Sudut, Iradiasi).
   - Langsung mengirim HTTP POST JSON ke endpoint REST Supabase setiap 5 detik.
   - **Tanpa memerlukan laptop atau browser web menyala!** Bekerja 24/7 mandiri.
2. **Daemon Python (`auto_logger.py`)**:
   - Dapat dijalankan di PC / Mini PC / Raspberry Pi.
   - Otomatis mengirimkan data sensor ke Supabase secara terus-menerus selama perangkat hidup.
3. **Fitur Auto-Streamer & Web Serial di Web Admin**:
   - Toggle switch *"Otomatis Kirim Data"* di header untuk simulasi pengujian realtime.
   - Tombol *"🔌 USB Serial"* untuk membaca data langsung dari port USB Arduino/ESP32 melalui peramban (Chrome / Edge).

### 4. Tombol & UI Live Monitor Serupa dengan HelioTrack
- Tombol **"🖥️ Buka Live Monitor"** di pojok kanan atas.
- Menampilkan panel monitor yang identik dengan [solar-panel-tracker](../solar-panel-tracker/homepage.html):
  - **Metric Summary Cards**: Power (kW), Voltage (V), Current (A), Irradiance (W/m²).
  - **Solar Health System**: Skor kesehatan 98.4%, badge status optimal, dan **jarum visualizer kemiringan & azimuth** yang berputar mengikuti nilai sudut input secara realtime!
  - **Today's Production Chart**: Grafik kurva pembangkitan daya harian SVG interaktif.
  - Nilai pada monitor langsung terupdate otomatis setiap ada data baru yang masuk dari form, alat ESP32, atau Supabase Realtime!

---

## Struktur Berkas

```
solar-panel-tracker-admin/
├── index.html            # Halaman utama Admin Portal (No Login, Clean Dark Theme)
├── style.css             # Desain antarmuka hijau emerald & dark minimalist
├── admin.js              # Kontroler form, sinkronisasi jam, slider sudut, & UI monitor
├── supabase-config.js    # Klien Supabase JS v2, CRUD, Realtime WebSocket, & Buffer Lokal
├── schema.sql            # Script PostgreSQL untuk membuat tabel di Supabase SQL Editor
├── esp32_firmware.ino    # Firmware Arduino/ESP32 untuk pengiriman otomatis saat alat menyala
├── auto_logger.py        # Skrip daemon Python pengirim telemetri otomatis
└── README.md             # Petunjuk lengkap penggunaan
```

---

## Cara Menjalankan & Memulai

### Langkah 1: Buat Tabel di Supabase (Hanya Sekali)
1. Buka dashboard proyek Supabase Anda: [https://supabase.com/dashboard](https://supabase.com/dashboard)
2. Masuk ke menu **SQL Editor** di bilah kiri.
3. Klik **+ New query**.
4. Buka file `schema.sql` (atau klik tombol **SQL Schema** di web admin, lalu klik **Copy**).
5. Tempel (*paste*) kode SQL tersebut, lalu klik tombol **Run**.
6. Tabel `solar_telemetry` dengan hak akses publik dan realtime telah aktif!

### Langkah 2: Buka Website Admin

#### Cara A (Langsung Buka Berkas):
Buka file `index.html` langsung di peramban web:
```bash
xdg-open /home/dimas/solar-panel-tracker-admin/index.html
```

#### Cara B (Menjalankan Web Server Lokal):
Jalankan server HTTP Python:
```bash
python3 -m http.server 8081 --directory /home/dimas/solar-panel-tracker-admin
```
Lalu buka browser di alamat: [http://localhost:8081](http://localhost:8081)

---

## Menghubungkan Alat Fisik (ESP32 / Arduino)

1. Buka file `esp32_firmware.ino` di **Arduino IDE**.
2. Masukkan nama Wi-Fi dan password Wi-Fi Anda pada baris:
   ```cpp
   const char* WIFI_SSID     = "NAMA_WIFI";
   const char* WIFI_PASSWORD = "PASSWORD_WIFI";
   ```
3. Upload kode ke board ESP32 Anda.
4. Buka *Serial Monitor* (Baudrate 115200).
5. Begitu alat terhubung ke Wi-Fi, telemetri otomatis terkirim ke Supabase setiap 5 detik!
6. Buka web admin ini, dan data baru dari ESP32 akan langsung muncul di tabel dan Live Monitor secara realtime tanpa perlu me-refresh halaman!
