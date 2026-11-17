# مدينة المتابعين — Instagram Unified Login

## Railway
1. تأكد أن تطبيق Meta مملوك لمحفظة أعمال، وأن تكوين Unified Login مخصص لحساب Instagram احترافي (Business/Creator) ويمنح صلاحيات قراءة الملف الشخصي والتعليقات المطلوبة.
2. ارفع `server.js` و`index.html` و`package.json` إلى مستودع GitHub ثم اربطه بخدمة Railway.
2. أضف Volume إلى الخدمة واجعل Mount Path هو `/data`.
3. أضف المتغيرات من `.env.example` في Railway Variables.
4. عيّن `IG_REDIRECT_URI` إلى:
   `https://YOUR-RAILWAY-DOMAIN/auth/instagram/callback`
5. في Meta > API setup with Unified login، أضف عنوان Redirect URI نفسه إلى إعداد Facebook Login for Business / التكوين، واحفظ.
6. ضع Meta App ID وMeta App Secret وConfiguration ID في Railway.
7. أعد النشر، افتح موقعك، ثم لوحة التحكم > الربط والبيانات > ربط حساب Instagram.

## ملاحظات مهمة
- هذه النسخة تستخدم Unified Login (`config_id`) لأن لوحة Meta التي أرسلتها تعرض هذا المسار للتطبيقات الجديدة؛ لا تستخدم Instagram App ID القديم ولا `instagram.com/oauth/authorize` التقليدي.
- لا تضع App Secret أو Access Token في HTML أو في المتصفح.
- يجب أن يمنح تكوين Meta أذونات قراءة الحساب والتعليقات المطلوبة، وأن يضم حساب Instagram المهني كأصل.
- إذا لم يستطع الخادم اكتشاف حساب Instagram بعد الموافقة، راجع أن التكوين منح أصل Instagram والصلاحيات، ويمكن ضبط `IG_BUSINESS_ID` أو `IG_USER_ID` بعد استخراج المعرّف الصحيح.
- Instagram API لا توفر قائمة المتابعين بأسمائهم؛ هذا المشروع يستخدم عدد المتابعين والتعليقات المتاحة عبر API، ويمكن استيراد قائمة المتابعين من ملف تنزيل بيانات Instagram.
