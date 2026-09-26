console.log("⏳ Mulai menjalankan Server.js...");
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();

// Konfigurasi CORS Spesifik (Sesuaikan URL Frontend Anda)
app.use(cors({
    origin: 'https://enrikoaw.github.io/Umkmkuliner', // Ganti dengan URL GitHub Pages frontend Anda
    optionsSuccessStatus: 200
}));

app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'lajurasa_secret_key_super_aman';

// ==========================================
// FITUR AUTENTIKASI (JWT & PIN)
// ==========================================
app.post('/api/login', (req, res) => {
    const { pin } = req.body;
    if (pin === '0000') {
        const token = jwt.sign({ role: 'kasir' }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, message: 'PIN salah' });
    }
});

app.post('/api/verify-manager', (req, res) => {
    const { pin } = req.body;
    if (pin === '1111') {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: 'PIN Manager salah' });
    }
});

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ success: false, message: 'Akses ditolak. Token tidak ditemukan.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ success: false, message: 'Sesi kedaluwarsa atau token tidak valid.' });
        req.user = user;
        next();
    });
};

// Konfigurasi koneksi database MySQL
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,//4000,
    ssl: { rejectUnauthorized: true }, 
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

let pool;

async function initializeDatabase() {
    try {
        pool = mysql.createPool(dbConfig);
        const connection = await pool.getConnection();
        console.log("Terhubung ke database MySQL 'umkm_kuliner'.");
        connection.release();
    } catch (error) {
        console.error("Gagal terhubung ke database:", error.message);
    }
}

// ==========================================
// ENDPOINT TERPROTEKSI (Menggunakan authenticateToken)
// ==========================================

// 1. GET /api/menu
app.get('/api/menu', authenticateToken, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM menu');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 1a. POST /api/menu
app.post('/api/menu', authenticateToken, async (req, res) => {
    const { Nama_Menu, Harga, Kategori, HPP } = req.body;
    if (!Nama_Menu || !Harga) return res.status(400).json({ success: false, message: 'Nama dan Harga wajib diisi' });
    try {
        await pool.query('INSERT INTO menu (Nama_Menu, Harga, Kategori, HPP) VALUES (?, ?, ?, ?)', [Nama_Menu, Harga, Kategori || 'Umum', HPP || 0]);
        res.json({ success: true, message: 'Menu berhasil ditambahkan' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 1b. PUT /api/menu/:id
app.put('/api/menu/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { Nama_Menu, Harga, Kategori, HPP } = req.body;
    try {
        await pool.query('UPDATE menu SET Nama_Menu = ?, Harga = ?, Kategori = ?, HPP = ? WHERE Idmenu = ?', [Nama_Menu, Harga, Kategori, HPP || 0, id]);
        res.json({ success: true, message: 'Menu berhasil diperbarui' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 1c. DELETE /api/menu/:id
app.delete('/api/menu/:id', authenticateToken, async (req, res) => {
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

// 2. POST /api/pesanan 
app.post('/api/pesanan', authenticateToken, async (req, res) => {
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
                subtotal: subtotal,
                catatan: item.catatan || null 
            });
        }

        const todayStr = new Date().toISOString().slice(0, 10);
        const [antreanRows] = await connection.query(`
            SELECT MAX(No_Antrean) as lastAntrean 
            FROM pesanan 
            WHERE DATE(Tanggal) = ?
        `, [todayStr]);
        
        const no_antrean = (antreanRows[0].lastAntrean || 0) + 1;

        const [pesananResult] = await connection.query(
            'INSERT INTO pesanan (Status, Total_Harga, Tanggal, No_Antrean) VALUES ("Pending", ?, NOW(), ?)',
            [total_harga, no_antrean]
        );
        const idpesanan = pesananResult.insertId;

        for (let vItem of verifiedItems) {
            await connection.query(
                'INSERT INTO detail_pesanan (Idpesanan, Idmenu, Jumlah, Subtotal, Catatan) VALUES (?, ?, ?, ?, ?)',
                [idpesanan, vItem.menu_id, vItem.jumlah, vItem.subtotal, vItem.catatan]
            );
        }

        await connection.commit();
        connection.release();

        res.status(201).json({ 
            success: true, 
            message: 'Pesanan berhasil dibuat.', 
            data: { idpesanan, total_harga, status: 'Pending', no_antrean } 
        });
    } catch (error) {
        await connection.rollback();
        connection.release();
        res.status(400).json({ success: false, message: error.message });
    }
});

// 3. GET /api/pesanan 
app.get('/api/pesanan', authenticateToken, async (req, res) => {
    try {
        const [pList] = await pool.query('SELECT *, Idpesanan as id, Status as status, Total_Harga as total_harga, No_Antrean as no_antrean FROM pesanan ORDER BY Idpesanan DESC');
        for (let p of pList) {
            const [dList] = await pool.query(`
                SELECT dp.*, m.Nama_Menu as nama_menu, dp.Jumlah as jumlah, dp.Catatan as catatan
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

// 4. PUT /api/pesanan/:id/status
app.put('/api/pesanan/:id/status', authenticateToken, async (req, res) => {
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

// 5. GET /api/laporan
app.get('/api/laporan', authenticateToken, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                DATE(p.Tanggal) as tanggal,
                SUM(dp.Subtotal) as total_pendapatan,
                SUM(dp.Subtotal - (IFNULL(m.HPP, 0) * dp.Jumlah)) as laba_bersih
            FROM pesanan p
            JOIN detail_pesanan dp ON p.Idpesanan = dp.Idpesanan
            JOIN menu m ON dp.Idmenu = m.Idmenu
            WHERE p.Status = 'Selesai'
            GROUP BY DATE(p.Tanggal)
            ORDER BY tanggal DESC
        `);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 6. GET /api/statistik/jam
app.get('/api/statistik/jam', authenticateToken, async (req, res) => {
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

// 7. GET /api/statistik/terlaris
app.get('/api/statistik/terlaris', authenticateToken, async (req, res) => {
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