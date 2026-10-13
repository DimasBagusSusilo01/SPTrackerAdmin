/**
 * ==============================================================================
 * HelioTrack Admin - Supabase Client Configuration & Database Operations
 * ==============================================================================
 */

const DEFAULT_SUPABASE_URL = 'https://cnitfsuiskyxhmcpwgsa.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNuaXRmc3Vpc2t5eGhtY3B3Z3NhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3Mjk0MzAsImV4cCI6MjEwNjMwNTQzMH0.Y70BsCBB9X6fs7SFfAVfmoniHQKF9l43eoLBJ6Gss9g';

const SolarDB = {
  client: null,
  realtimeSubscription: null,
  tableName: 'solar_telemetry',

  // Ambil URL & Key aktif (dari localStorage jika pengguna pernah mengubah, atau default)
  getUrl() {
    return localStorage.getItem('solar_admin_supa_url') || DEFAULT_SUPABASE_URL;
  },

  getKey() {
    return localStorage.getItem('solar_admin_supa_key') || DEFAULT_SUPABASE_ANON_KEY;
  },

  saveCredentials(url, key) {
    if (url) localStorage.setItem('solar_admin_supa_url', url.trim());
    if (key) localStorage.setItem('solar_admin_supa_key', key.trim());
    this.client = null; // Reset agar createClient ulang
    return this.init();
  },

  resetCredentials() {
    localStorage.removeItem('solar_admin_supa_url');
    localStorage.removeItem('solar_admin_supa_key');
    this.client = null;
    return this.init();
  },

  // Inisialisasi Supabase JS Client v2
  init() {
    if (this.client) return this.client;

    const url = this.getUrl();
    const key = this.getKey();

    if (window.supabase && typeof window.supabase.createClient === 'function') {
      try {
        this.client = window.supabase.createClient(url, key, {
          auth: {
            persistSession: false,
            autoRefreshToken: false
          }
        });
        console.log('[SolarDB] Supabase client berhasil diinisialisasi untuk URL:', url);
      } catch (err) {
        console.error('[SolarDB] Error inisialisasi Supabase:', err);
      }
    } else {
      console.warn('[SolarDB] @supabase/supabase-js library belum termuat.');
    }

    return this.client;
  },

  // Periksa konektivitas & status tabel Supabase
  async testConnection() {
    const client = this.init();
    if (!client) {
      return { success: false, status: 'client_missing', message: 'Library Supabase belum siap' };
    }

    try {
      // Coba query limit 1 dari tabel solar_telemetry
      const { data, error, status } = await client
        .from(this.tableName)
        .select('id, created_at')
        .limit(1);

      if (error) {
        // Jika tabel belum dibuat (PGRST205)
        if (error.code === 'PGRST205' || error.message?.includes('schema cache')) {
          return {
            success: false,
            status: 'table_missing',
            message: `Koneksi Supabase terhubung, namun tabel '${this.tableName}' belum dibuat. Jalankan schema.sql di Supabase SQL Editor.`,
            error
          };
        }
        return {
          success: false,
          status: 'query_error',
          message: error.message || 'Gagal membaca tabel Supabase',
          error
        };
      }

      return {
        success: true,
        status: 'connected',
        message: 'Koneksi Database Supabase Aktif & Tabel Siap!',
        data
      };
    } catch (err) {
      return {
        success: false,
        status: 'network_error',
        message: err.message || 'Gagal tersambung ke server Supabase',
        err
      };
    }
  },

  // Kirim (Insert) record telemetri baru ke Supabase
  async insertTelemetry(record) {
    const client = this.init();

    // Selalu simpan juga ke LocalStorage buffer cadangan
    this.saveToLocalBuffer(record);

    if (!client) {
      return { success: false, fallback: true, message: 'Disimpan di buffer lokal (klien offline)' };
    }

    try {
      const payload = {
        waktu_tanggal: record.waktu_tanggal,
        waktu_jam: record.waktu_jam,
        voltase: parseFloat(record.voltase),
        arus_listrik: parseFloat(record.arus_listrik),
        daya: parseFloat(record.daya),
        energi_listrik: parseFloat(record.energi_listrik),
        irradiansi: parseFloat(record.irradiansi),
        besar_sudut: parseFloat(record.besar_sudut),
        device_id: record.device_id || 'ADMIN-PANEL-01',
        sumber: record.sumber || 'admin_web'
      };

      const { data, error } = await client
        .from(this.tableName)
        .insert([payload])
        .select();

      if (error) {
        console.warn('[SolarDB] Gagal insert ke Supabase, menggunakan fallback lokal:', error.message);
        return {
          success: false,
          fallback: true,
          error: error.message,
          code: error.code
        };
      }

      return { success: true, data: data?.[0] || payload };
    } catch (err) {
      console.warn('[SolarDB] Error jaringan insert:', err);
      return { success: false, fallback: true, error: err.message };
    }
  },

  // Ambil data telemetri terbaru
  async fetchRecent(limit = 25) {
    const client = this.init();
    if (!client) {
      return this.getLocalBuffer();
    }

    try {
      const { data, error } = await client
        .from(this.tableName)
        .select('*')
        .order('id', { ascending: false })
        .limit(limit);

      if (error) {
        console.warn('[SolarDB] Gagal fetch dari Supabase, memuat dari buffer lokal:', error.message);
        return this.getLocalBuffer();
      }

      if (data && data.length > 0) {
        return data;
      }
      return this.getLocalBuffer();
    } catch (err) {
      return this.getLocalBuffer();
    }
  },

  // Hapus data berdasarkan ID
  async deleteTelemetry(id) {
    // Hapus dari local buffer
    this.deleteFromLocalBuffer(id);

    const client = this.init();
    if (!client) return { success: true, localOnly: true };

    try {
      const { error } = await client
        .from(this.tableName)
        .delete()
        .eq('id', id);

      if (error) {
        return { success: false, error: error.message };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  // Langganan Realtime Supabase (WebSocket)
  // Menangkap data yang dikirim oleh ESP32 / Python secara langsung
  subscribeToChanges(onNewRecord) {
    const client = this.init();
    if (!client) return null;

    try {
      if (this.realtimeSubscription) {
        client.removeChannel(this.realtimeSubscription);
      }

      const channel = client
        .channel('public:solar_telemetry_changes')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: this.tableName },
          (payload) => {
            console.log('[SolarDB Realtime] Data baru diterima dari alat IoT:', payload.new);
            if (typeof onNewRecord === 'function') {
              onNewRecord(payload.new);
            }
          }
        )
        .subscribe((status) => {
          console.log('[SolarDB Realtime Status]:', status);
        });

      this.realtimeSubscription = channel;
      return channel;
    } catch (err) {
      console.warn('[SolarDB] Realtime tidak dapat diaktifkan:', err);
      return null;
    }
  },

  // ==========================================
  // LOCAL STORAGE BUFFER (FALLBACK CERDAS)
  // ==========================================
  getLocalBuffer() {
    try {
      const raw = localStorage.getItem('solar_admin_local_buffer');
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    // Seed default records awal jika kosong agar UI langsung menarik
    return [
      {
        id: 'DEMO-103',
        created_at: new Date(Date.now() - 60000).toISOString(),
        waktu_tanggal: new Date().toISOString().split('T')[0],
        waktu_jam: new Date(Date.now() - 60000).toTimeString().split(' ')[0],
        voltase: 386.2,
        arus_listrik: 12.6,
        daya: 4866.12,
        energi_listrik: 34.82,
        irradiansi: 902.0,
        besar_sudut: 35.0,
        device_id: 'ESP32-SOLAR-01',
        sumber: 'esp32_iot'
      },
      {
        id: 'DEMO-102',
        created_at: new Date(Date.now() - 180000).toISOString(),
        waktu_tanggal: new Date().toISOString().split('T')[0],
        waktu_jam: new Date(Date.now() - 180000).toTimeString().split(' ')[0],
        voltase: 385.4,
        arus_listrik: 12.5,
        daya: 4817.50,
        energi_listrik: 34.78,
        irradiansi: 895.0,
        besar_sudut: 34.5,
        device_id: 'ADMIN-MANUAL',
        sumber: 'admin_web'
      },
      {
        id: 'DEMO-101',
        created_at: new Date(Date.now() - 360000).toISOString(),
        waktu_tanggal: new Date().toISOString().split('T')[0],
        waktu_jam: new Date(Date.now() - 360000).toTimeString().split(' ')[0],
        voltase: 384.0,
        arus_listrik: 12.3,
        daya: 4723.20,
        energi_listrik: 34.65,
        irradiansi: 880.0,
        besar_sudut: 34.0,
        device_id: 'ESP32-SOLAR-01',
        sumber: 'esp32_iot'
      }
    ];
  },

  saveToLocalBuffer(record) {
    try {
      const buffer = this.getLocalBuffer();
      const newEntry = {
        id: record.id || `LOC-${Date.now()}`,
        created_at: new Date().toISOString(),
        ...record
      };
      buffer.unshift(newEntry);
      if (buffer.length > 100) buffer.pop(); // Batasi 100 log terbaru
      localStorage.setItem('solar_admin_local_buffer', JSON.stringify(buffer));
    } catch (e) {}
  },

  deleteFromLocalBuffer(id) {
    try {
      const buffer = this.getLocalBuffer().filter((item) => String(item.id) !== String(id));
      localStorage.setItem('solar_admin_local_buffer', JSON.stringify(buffer));
    } catch (e) {}
  },

  clearLocalBuffer() {
    localStorage.removeItem('solar_admin_local_buffer');
  }
};

window.SolarDB = SolarDB;
