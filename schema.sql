-- ==============================================================================
-- SCHEMA SQL: TABEL SOLAR TELEMETRY UNTUK SUPABASE
-- HelioTrack Admin & IoT Solar Panel Tracker
-- ==============================================================================
-- Jalankan query ini di Dashboard Supabase:
-- Menu -> SQL Editor -> Klik "+ New query" -> Tempel (Paste) kode ini -> Klik "Run"
-- ==============================================================================

-- 1. Buat Tabel solar_telemetry
CREATE TABLE IF NOT EXISTS public.solar_telemetry (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    waktu_tanggal DATE NOT NULL DEFAULT CURRENT_DATE,
    waktu_jam TIME NOT NULL DEFAULT CURRENT_TIME,
    voltase NUMERIC(8, 2) NOT NULL,          -- Tegangan listrik (V), contoh: 385.40
    arus_listrik NUMERIC(8, 2) NOT NULL,     -- Arus listrik (A), contoh: 12.50
    daya NUMERIC(10, 2) NOT NULL,            -- Daya listrik (W), contoh: 4817.50
    energi_listrik NUMERIC(10, 2) NOT NULL,  -- Energi listrik (Wh atau kWh), contoh: 34.80
    irradiansi NUMERIC(8, 1) NOT NULL,       -- Iradiasi matahari (W/m²), contoh: 895.0
    besar_sudut NUMERIC(6, 1) NOT NULL,      -- Besar sudut pelacak (° derajat), contoh: 34.5
    device_id TEXT DEFAULT 'SOLAR-TRACKER-01', -- Identitas perangkat (misal ESP32)
    sumber TEXT DEFAULT 'admin_web'          -- 'admin_web', 'esp32_iot', 'auto_streamer'
);

-- 2. Buat Index untuk mempercepat query berdasarkan waktu terbaru
CREATE INDEX IF NOT EXISTS idx_solar_telemetry_created_at 
ON public.solar_telemetry (created_at DESC);

-- 3. Aktifkan Row Level Security (RLS)
ALTER TABLE public.solar_telemetry ENABLE ROW LEVEL SECURITY;

-- 4. Buat Kebijakan Akses (Policies) agar siapapun dengan Anon Key dapat membaca dan mengirim data
-- (Sangat penting agar ESP32 / Arduino / Admin tanpa login dapat memasukkan data secara otomatis)

-- Izinkan SELECT (Membaca data)
DROP POLICY IF EXISTS "Izinkan baca publik" ON public.solar_telemetry;
CREATE POLICY "Izinkan baca publik" 
ON public.solar_telemetry 
FOR SELECT 
USING (true);

-- Izinkan INSERT (Mengirim data dari admin web & mikrokontroler)
DROP POLICY IF EXISTS "Izinkan insert publik" ON public.solar_telemetry;
CREATE POLICY "Izinkan insert publik" 
ON public.solar_telemetry 
FOR INSERT 
WITH CHECK (true);

-- Izinkan DELETE (Menghapus data pengujian dari admin)
DROP POLICY IF EXISTS "Izinkan delete publik" ON public.solar_telemetry;
CREATE POLICY "Izinkan delete publik" 
ON public.solar_telemetry 
FOR DELETE 
USING (true);

-- 5. Aktifkan Supabase Realtime untuk tabel ini
-- Agar data baru yang masuk dari alat IoT langsung muncul di web admin tanpa refresh halaman
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'solar_telemetry'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.solar_telemetry;
  END IF;
END $$;
