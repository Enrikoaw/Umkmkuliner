console.log("⏳ Mulai menjalankan Server.js...");
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const cors = require('cors');
app.use(cors());

// Konfigurasi koneksi database MySQL "umkm_kuliner"
const dbConfig = {
    host: 'gateway01.ap-southeast-1.prod.alicloud.tidbcloud.com',
    user: 'tx9oWrEPGNDydHC.root',
    password: '7SDMLRCRXEDVgINp',
    port: 4000,
    database: 'umkm_kuliner',
    ssl: { rejectUnauthorized: true }, // Diperlukan oleh TiDB Cloud
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

let pool;

async function initializeDatabase() {
    try {
        pool = mysql.createPool(dbConfig);
        const connection = await pool.getConnection();
        console.log("Terhubung ke database MySQL 'umkm_kuliner'. (Mode Rumah Makan - Tanpa Stok)");
        connection.release();
    } catch (error) {
        console.error("Gagal terhubung ke database:", error.message);
    }
}

// ==========================================
// FITUR MANAJEMEN MENU (CRUD)
// ==========================================
// 1. GET /api/menu: Mengambil daftar menu
app.get('/api/menu', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM menu');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 1a. POST /api/menu: Tambah Menu Baru
app.post('/api/menu', async (req, res) => {
    const { Nama_Menu, Harga, Kategori } = req.body;
    if (!Nama_Menu || !Harga) return res.status(400).json({ success: false, message: 'Nama dan Harga wajib diisi' });
    try {
        await pool.query('INSERT INTO menu (Nama_Menu, Harga, Kategori) VALUES (?, ?, ?)', [Nama_Menu, Harga, Kategori || 'Umum']);
        res.json({ success: true, message: 'Menu berhasil ditambahkan' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 1b. PUT /api/menu/:id: Edit Menu
app.put('/api/menu/:id', async (req, res) => {
    const { id } = req.params;
    const { Nama_Menu, Harga, Kategori } = req.body;
    try {
        await pool.query('UPDATE menu SET Nama_Menu = ?, Harga = ?, Kategori = ? WHERE Idmenu = ?', [Nama_Menu, Harga, Kategori, id]);
        res.json({ success: true, message: 'Menu berhasil diperbarui' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 1c. DELETE /api/menu/:id: Hapus Menu
app.delete('/api/menu/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM menu WHERE Idmenu = ?', [id]);
        res.json({ success: true, message: 'Menu berhasil dihapus' });
    } catch (error) {
        if (error.code === 'ER_ROW_IS_REFERENCED_2') {
            res.status(400).json({ success: false, message: 'Gagal! Menu ini tidak bisa dihapus karena tersimpan di riwayat pesanan.' });
        } else {
            res.status(500).json({ success: false, message: error.message });
        }
    }
});

// ==========================================
// FITUR TRANSAKSI & LAPORAN 
// ==========================================
// 2. POST /api/pesanan: Menerima input pesanan tanpa validasi stok
app.post('/api/pesanan', async (req, res) => {
    const { items } = req.body; 

    if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: 'Data pesanan tidak valid.' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        let total_harga = 0;
        const verifiedItems = [];

        for (let item of items) {
            const [menuRows] = await connection.query('SELECT * FROM menu WHERE Idmenu = ?', [item.menu_id]);
            if (menuRows.length === 0) throw new Error(`Menu dengan ID ${item.menu_id} tidak ditemukan.`);

            const menu = menuRows[0];
            const subtotal = Number(menu.Harga) * Number(item.jumlah);
            total_harga += subtotal;

            verifiedItems.push({
                menu_id: menu.Idmenu,
                jumlah: Number(item.jumlah),
                subtotal: subtotal
            });
        }

        const [pesananResult] = await connection.query(
            'INSERT INTO pesanan (Status, Total_Harga, Tanggal) VALUES ("Pending", ?, NOW())',
            [total_harga]
        );
        const idpesanan = pesananResult.insertId;

        for (let vItem of verifiedItems) {
            await connection.query(
                'INSERT INTO detail_pesanan (Idpesanan, Idmenu, Jumlah, Subtotal) VALUES (?, ?, ?, ?)',
                [idpesanan, vItem.menu_id, vItem.jumlah, vItem.subtotal]
            );
        }

        await connection.commit();
        connection.release();

        res.status(201).json({ success: true, message: 'Pesanan berhasil dibuat.', data: { idpesanan, total_harga, status: 'Pending' } });
    } catch (error) {
        await connection.rollback();
        connection.release();
        res.status(400).json({ success: false, message: error.message });
    }
});

// 3. GET /api/pesanan: Mengambil daftar seluruh pesanan
app.get('/api/pesanan', async (req, res) => {
    try {
        const [pList] = await pool.query('SELECT *, Idpesanan as id, Status as status, Total_Harga as total_harga FROM pesanan ORDER BY Tanggal DESC');
        for (let p of pList) {
            const [dList] = await pool.query(`
                SELECT dp.*, m.Nama_Menu as nama_menu, dp.Jumlah as jumlah
                FROM detail_pesanan dp 
                JOIN menu m ON dp.Idmenu = m.Idmenu 
                WHERE dp.Idpesanan = ?
            `, [p.Idpesanan]);
            p.items = dList;
        }
        res.json({ success: true, data: pList });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 4. PUT /api/pesanan/:id/status: Mengubah status pesanan
app.put('/api/pesanan/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const validStatuses = ['Pending', 'Diproses', 'Selesai'];
    if (!validStatuses.includes(status)) return res.status(400).json({ success: false, message: 'Status tidak valid.' });

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [pesananRows] = await connection.query('SELECT * FROM pesanan WHERE Idpesanan = ? FOR UPDATE', [id]);
        if (pesananRows.length === 0) throw new Error('Pesanan tidak ditemukan.');

        const pesanan = pesananRows[0];
        await connection.query('UPDATE pesanan SET Status = ? WHERE Idpesanan = ?', [status, id]);

        if (status === 'Selesai' && pesanan.Status !== 'Selesai') {
            const today = new Date().toISOString().slice(0, 10);
            const [laporanRows] = await connection.query('SELECT * FROM laporan_keuangan WHERE Tanggal_Pencatatan = ? FOR UPDATE', [today]);

            if (laporanRows.length > 0) {
                await connection.query('UPDATE laporan_keuangan SET Pendapatan = Pendapatan + ? WHERE Tanggal_Pencatatan = ?', [pesanan.Total_Harga, today]);
            } else {
                await connection.query('INSERT INTO laporan_keuangan (Tanggal_Pencatatan, Pendapatan, Idpesanan) VALUES (?, ?, ?)', [today, pesanan.Total_Harga, id]);
            }
        }

        await connection.commit();
        connection.release();
        res.json({ success: true, message: `Status diubah menjadi ${status}.` });
    } catch (error) {
        await connection.rollback();
        connection.release();
        res.status(400).json({ success: false, message: error.message });
    }
});

// 5. GET /api/laporan: Laporan Keuangan
app.get('/api/laporan', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT *, Tanggal_Pencatatan as tanggal, Pendapatan as total_pendapatan FROM laporan_keuangan ORDER BY Tanggal_Pencatatan DESC');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// FITUR STATISTIKA ANALITIK
// ==========================================
// 6. GET /api/statistik/jam: Mengambil data jam sibuk (Peak Hours)
app.get('/api/statistik/jam', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT HOUR(Tanggal) as jam, COUNT(Idpesanan) as total_order 
            FROM pesanan 
            WHERE Status = "Selesai" 
            GROUP BY HOUR(Tanggal) 
            ORDER BY jam ASC
        `);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 7. GET /api/statistik/terlaris: Mengambil data menu paling laris (7 hari terakhir)
app.get('/api/statistik/terlaris', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT m.Nama_Menu as nama_menu, SUM(dp.Jumlah) as total_terjual
            FROM pesanan p
            JOIN detail_pesanan dp ON p.Idpesanan = dp.Idpesanan
            JOIN menu m ON dp.Idmenu = m.Idmenu
            WHERE p.Status = 'Selesai' 
              AND p.Tanggal >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
            GROUP BY m.Idmenu, m.Nama_Menu
            ORDER BY total_terjual DESC
            LIMIT 5
        `);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
initializeDatabase().then(() => {
    app.listen(PORT, () => console.log(`✅ Server berjalan di http://localhost:${PORT}`));
});
