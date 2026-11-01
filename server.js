const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'scout_attendance_secret';

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'scout_attendance',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  multipleStatements: true,
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function normalizePhone(phone) {
  if (!phone) return '';
  return String(phone).replace(/\\D/g, '');
}

function buildWhatsAppLink(phone, message) {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) return null;
  return `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`;
}

function getLockMinutes(sessionType) {
  const map = {
    CLASS: 90,
    SURVEY: 120,
    TRIP: 180,
  };
  return map[sessionType] || 90;
}

function isSessionLocked(sessionDate, sessionType) {
  if (!sessionDate) return false;
  const sessionTime = new Date(sessionDate).getTime();
  const now = Date.now();
  const minutesPassed = (now - sessionTime) / (1000 * 60);
  return minutesPassed > getLockMinutes(sessionType);
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'غير مصرح لك. الرجاء تسجيل الدخول أولاً.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'رمز الدخول غير صالح أو منتهي.' });
  }
}

function requireRole(requiredRole) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== requiredRole) {
      return res.status(403).json({ message: 'ليس لديك صلاحية للنفاذ إلى هذه الصفحة.' });
    }
    next();
  };
}

async function initializeDatabase() {
  const connection = await pool.getConnection();

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        role ENUM('ADMIN','TEACHER') NOT NULL DEFAULT 'TEACHER',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS classes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        class_name VARCHAR(150) NOT NULL,
        teacher_id INT,
        FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS students (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_name VARCHAR(150) NOT NULL,
        class_id INT NOT NULL,
        parent_phone VARCHAR(50) NULL,
        FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        session_type ENUM('CLASS','SURVEY','TRIP') NOT NULL,
        status ENUM('PRESENT','ABSENT','LATE') NOT NULL,
        session_date DATETIME NOT NULL,
        is_locked TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        UNIQUE KEY unique_student_session (student_id, session_type, session_date)
      )
    `);

    const [userCountResult] = await connection.query('SELECT COUNT(*) AS count FROM users');
    const userCount = userCountResult[0].count;

    if (userCount === 0) {
      const adminPassword = await bcrypt.hash('admin123', 10);
      const teacherPassword = await bcrypt.hash('teacher123', 10);

      await connection.query(
        'INSERT INTO users (username, password, role) VALUES (?, ?, ?), (?, ?, ?)',
        ['admin', adminPassword, 'ADMIN', 'teacher1', teacherPassword, 'TEACHER']
      );

      const [teacherRows] = await connection.query('SELECT id FROM users WHERE username = ?', ['teacher1']);
      const teacherId = teacherRows[0].id;

      await connection.query(
        'INSERT INTO classes (class_name, teacher_id) VALUES (?, ?), (?, ?), (?, ?)',
        ['فرقة الكشافة', teacherId, 'فرقة العلوم', null, 'فرقة الرواد', null]
      );

      const [classesRows] = await connection.query('SELECT id, class_name FROM classes');
      const classMap = Object.fromEntries(classesRows.map((item) => [item.class_name, item.id]));

      await connection.query(
        'INSERT INTO students (student_name, class_id, parent_phone) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)',
        [
          'أحمد ناصر', classMap['فرقة الكشافة'], '+966500123456',
          'سارة علي', classMap['فرقة الكشافة'], '+966500123457',
          'محمود يوسف', classMap['فرقة الكشافة'], '+966500123458',
          'ليلى أحمد', classMap['فرقة العلوم'], '+966500123459',
          'حسن الطويل', classMap['فرقة العلوم'], '+966500123460',
          'سلمان فهد', classMap['فرقة الرواد'], '+966500123461'
        ]
      );
    }
  } finally {
    connection.release();
  }
}

async function ensureTeacherOwnsClass(teacherId, classId) {
  const [rows] = await pool.query('SELECT id FROM classes WHERE id = ? AND teacher_id = ?', [classId, teacherId]);
  return rows.length > 0;
}

app.get('/', (req, res) => {
  res.redirect('/login.html');
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ message: 'اسم المستخدم وكلمة المرور مطلوبان.' });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ message: 'اسم المستخدم غير موجود.' });
    }

    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches) {
      return res.status(401).json({ message: 'كلمة المرور غير صحيحة.' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '8h' });

    return res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
      redirect: user.role === 'ADMIN' ? '/admin_dashboard.html' : '/teacher_panel.html',
    });
  } catch (error) {
    return res.status(500).json({ message: 'حدث خطأ في تسجيل الدخول.', error: error.message });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const [rows] = await pool.query('SELECT id, username, role FROM users WHERE id = ?', [req.user.id]);
  if (!rows.length) {
    return res.status(404).json({ message: 'المستخدم غير موجود.' });
  }

  return res.json({ user: rows[0] });
});

app.get('/api/admin/classes', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM classes ORDER BY class_name ASC');
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ message: 'فشل تحميل الأقسام.', error: error.message });
  }
});

app.get('/api/admin/stats', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        c.id AS classId,
        c.class_name AS className,
        COUNT(DISTINCT s.id) AS totalStudents,
        SUM(CASE WHEN a.status = 'PRESENT' THEN 1 ELSE 0 END) AS present,
        SUM(CASE WHEN a.status = 'ABSENT' THEN 1 ELSE 0 END) AS absent,
        SUM(CASE WHEN a.status = 'LATE' THEN 1 ELSE 0 END) AS late
      FROM classes c
      LEFT JOIN students s ON s.class_id = c.id
      LEFT JOIN attendance a ON a.student_id = s.id
      GROUP BY c.id, c.class_name
      ORDER BY c.class_name ASC
    `);

    return res.json(rows.map((row) => ({
      classId: row.classId,
      className: row.className,
      totalStudents: Number(row.totalStudents || 0),
      present: Number(row.present || 0),
      absent: Number(row.absent || 0),
      late: Number(row.late || 0),
    })));
  } catch (error) {
    return res.status(500).json({ message: 'فشل تحميل إحصائيات الإدارة.', error: error.message });
  }
});

app.get('/api/admin/teachers', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id, u.username, u.role, c.class_name
      FROM users u
      LEFT JOIN classes c ON c.teacher_id = u.id
      WHERE u.role = 'TEACHER'
      ORDER BY u.username ASC
    `);
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ message: 'فشل تحميل قائمة الأساتذة.', error: error.message });
  }
});

app.post('/api/admin/teachers', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  const { username, password, classId } = req.body || {};

  if (!username || !password || !classId) {
    return res.status(400).json({ message: 'اسم المستخدم وكلمة المرور والفصل مطلوبان.' });
  }

  try {
    const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length > 0) {
      return res.status(409).json({ message: 'اسم المستخدم موجود مسبقاً.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await pool.query('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [username, hashedPassword, 'TEACHER']);
    const teacherId = result.insertId;

    await pool.query('UPDATE classes SET teacher_id = ? WHERE id = ?', [teacherId, Number(classId)]);

    return res.status(201).json({ message: 'تم إنشاء حساب الأستاذ بنجاح.', teacher: { id: teacherId, username } });
  } catch (error) {
    return res.status(500).json({ message: 'فشل إنشاء حساب الأستاذ.', error: error.message });
  }
});

app.get('/api/teacher/classes', authMiddleware, requireRole('TEACHER'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM classes WHERE teacher_id = ? ORDER BY class_name ASC', [req.user.id]);
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ message: 'فشل تحميل الأقسام.', error: error.message });
  }
});

app.get('/api/teacher/students/:classId', authMiddleware, requireRole('TEACHER'), async (req, res) => {
  const classId = Number(req.params.classId);

  try {
    const allowed = await ensureTeacherOwnsClass(req.user.id, classId);
    if (!allowed) {
      return res.status(403).json({ message: 'لا يمكنك الوصول إلى هذه الفئة.' });
    }

    const [rows] = await pool.query('SELECT * FROM students WHERE class_id = ? ORDER BY student_name ASC', [classId]);
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ message: 'فشل تحميل قائمة التلاميذ.', error: error.message });
  }
});

app.post('/api/teacher/attendance', authMiddleware, requireRole('TEACHER'), async (req, res) => {
  const { classId, studentId, sessionType, status, sessionDate } = req.body || {};

  if (!classId || !studentId || !sessionType || !status || !sessionDate) {
    return res.status(400).json({ message: 'البيانات غير مكتملة.' });
  }

  try {
    const allowed = await ensureTeacherOwnsClass(req.user.id, Number(classId));
    if (!allowed) {
      return res.status(403).json({ message: 'لا يمكنك تسجيل حضور هذه الفئة.' });
    }

    if (isSessionLocked(sessionDate, sessionType)) {
      return res.status(403).json({ message: 'تم قفل الحصة تلقائياً لأن الوقت انتهى.' });
    }

    const dbSessionDate = new Date(sessionDate).toISOString().slice(0, 19).replace('T', ' ');

    const [studentRows] = await pool.query('SELECT * FROM students WHERE id = ? AND class_id = ?', [studentId, classId]);
    if (!studentRows.length) {
      return res.status(404).json({ message: 'هذا التلميذ غير موجود في هذه الفئة.' });
    }

    const [existingRows] = await pool.query(
      'SELECT * FROM attendance WHERE student_id = ? AND session_type = ? AND session_date = ?',
      [studentId, sessionType, dbSessionDate]
    );

    if (existingRows.length > 0) {
      await pool.query('UPDATE attendance SET status = ?, is_locked = 0 WHERE id = ?', [status.toUpperCase(), existingRows[0].id]);
    } else {
      await pool.query('INSERT INTO attendance (student_id, session_type, status, session_date, is_locked) VALUES (?, ?, ?, ?, 0)', [studentId, sessionType, status.toUpperCase(), dbSessionDate]);
    }

    return res.json({ message: 'تم تسجيل الحضور بنجاح.' });
  } catch (error) {
    return res.status(500).json({ message: 'فشل تسجيل الحضور.', error: error.message });
  }
});

app.get('/api/teacher/export/:classId', authMiddleware, requireRole('TEACHER'), async (req, res) => {
  const classId = Number(req.params.classId);

  try {
    const allowed = await ensureTeacherOwnsClass(req.user.id, classId);
    if (!allowed) {
      return res.status(403).json({ message: 'لا يمكنك تصدير تقرير هذه الفئة.' });
    }

    const [rows] = await pool.query(`
      SELECT s.student_name, a.session_type, a.status, a.session_date
      FROM attendance a
      INNER JOIN students s ON s.id = a.student_id
      WHERE s.class_id = ?
      ORDER BY a.session_date DESC
    `, [classId]);

    const csvHeader = 'student_name,session_type,status,session_date\n';
    const csvBody = rows.map((row) => `${row.student_name},${row.session_type},${row.status},${row.session_date}`).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=\"attendance-class-${classId}.csv\"`);
    return res.send(csvHeader + csvBody);
  } catch (error) {
    return res.status(500).json({ message: 'حدث خطأ أثناء تصدير الملف.', error: error.message });
  }
});

app.post('/api/teacher/notify', authMiddleware, requireRole('TEACHER'), async (req, res) => {
  const { studentId, classId, sessionType, status } = req.body || {};

  if (!studentId || !classId || !sessionType || !status) {
    return res.status(400).json({ message: 'بيانات الإشعار غير مكتملة.' });
  }

  try {
    const allowed = await ensureTeacherOwnsClass(req.user.id, Number(classId));
    if (!allowed) {
      return res.status(403).json({ message: 'لا يمكنك إرسال إشعار لهذه الفئة.' });
    }

    const [studentRows] = await pool.query('SELECT * FROM students WHERE id = ? AND class_id = ?', [studentId, classId]);
    if (!studentRows.length) {
      return res.status(404).json({ message: 'التلميذ غير موجود في هذه الفئة.' });
    }

    const student = studentRows[0];
    const statusText = status === 'ABSENT' ? 'غائب' : status === 'LATE' ? 'متأخر' : 'حاضر';
    const sessionText = sessionType === 'CLASS' ? 'حصة' : sessionType === 'SURVEY' ? 'استطلاع' : 'رحلة كشفية';
    const message = `السلام عليكم، نود إعلامكم بأن ابنكم ${student.student_name} كان ${statusText} في ${sessionText} اليوم. نتطلع إلى متابعة الحضور والالتزام.`;
    const whatsappLink = buildWhatsAppLink(student.parent_phone, message);

    if (!whatsappLink) {
      return res.status(400).json({ message: 'لا يوجد رقم هاتف للولي/الأهل لإرسال الإشعار.' });
    }

    return res.json({
      ok: true,
      url: whatsappLink,
      message,
      parentPhone: student.parent_phone,
    });
  } catch (error) {
    return res.status(500).json({ message: 'فشل إرسال الإشعار.', error: error.message });
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

async function startServer() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Unable to initialize database:', error);
    process.exit(1);
  }
}

startServer();