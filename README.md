# نظام حضور وغياب التلاميذ والأنشطة الكشفية

هذا المشروع يحتوي على:
- نظام تسجيل دخول
- لوحة إدارة (ADMIN)
- لوحة مدرس/أستاذ (TEACHER)
- سجل حضور وغياب
- دعم أنواع النشاط: حصة، استطلاع، رحلة كشفية
- قفل الحصة تلقائياً بعد انتهاء الوقت المحدد
- إرسال إشعار WhatsApp تلقائياً للأولياء في حالات الغياب أو التأخر
- تصدير تقرير CSV

## التثبيت
1. قم بإنشاء قاعدة بيانات MySQL باسم: scout_attendance
2. نفذ ملف db/schema.sql
3. انسخ .env.example إلى .env واضبط القيم
4. شغّل:
   npm install
   npm start

## الحسابات الافتراضية
- الإدارة:
  - username: admin
  - password: admin123
- الأستاذ:
  - username: teacher1
  - password: teacher123

## الروابط
- تسجيل الدخول: http://localhost:3000/login.html
- لوحة الإدارة: http://localhost:3000/admin_dashboard.html
- لوحة الأستاذ: http://localhost:3000/teacher_panel.html