# AI Cinematic Storyboard & Script Studio — درست شدہ پیکج

اس پیکج میں اصل اسٹوڈیو کا HTML ڈیزائن اور پانچوں ٹولز برقرار ہیں: Full Cinematic Script، AI Visual Prompts، Character Bible، High-CTR Thumbnail، اور Urdu Dialogue Formatter۔ فرنٹ اینڈ اب Gemini کو براہِ راست API key نہیں بھیجتا؛ درخواست مقامی Node.js سرور کے ذریعے جاتی ہے۔

## چلانے کا طریقہ (Windows)
1. ZIP فائل کو ایک فولڈر میں Extract کریں۔
2. Node.js کا ورژن 20 یا نیا انسٹال کریں۔ Terminal/CMD میں `node --version` سے چیک کریں۔
3. `.env.example` کی کاپی بنائیں اور اس کا نام `.env` رکھیں۔
4. `.env` فائل کھول کر `GEMINI_API_KEY=` کے بعد اپنی Google AI Studio API key رکھیں۔ key کو کسی کے ساتھ شیئر نہ کریں اور ZIP میں شامل نہ کریں۔
5. اسی فولڈر میں Terminal/CMD کھولیں اور `npm start` چلائیں۔
6. براؤزر میں `http://127.0.0.1:3000` کھولیں۔
7. Settings میں API status دیکھیں۔ اگر **API key missing on server** دکھے تو `.env` چیک کریں، سرور بند کرکے دوبارہ چلائیں۔
8. پہلے مختصر prompt اور کم scenes کے ساتھ Generate Output ٹیسٹ کریں۔ استعمال کے مطابق Google API کی لاگت یا quota لاگو ہو سکتی ہے۔

## ٹیسٹ
- `npm test` سرور کے بنیادی smoke tests چلاتا ہے۔
- `node --check server.js` سرور JavaScript کی syntax چیک کرتا ہے۔
- `/api/health` سرور اور API key configuration کی حالت بتاتا ہے۔
- حقیقی AI generation کی تصدیق کے لیے درست API key، انٹرنیٹ، اور Google کی جانب سے منتخب ماڈل کی دستیابی ضروری ہے؛ اس پیکج میں live Gemini generation کا دعویٰ نہیں کیا جا رہا۔

## حفاظت کی اہم بات
- `.env` میں اپنی API key رکھیں؛ اسے `index.html` یا public repository میں نہ ڈالیں۔ `.gitignore` میں `.env` شامل ہے۔
- یہ مقامی/ابتدائی آزمائش کے لیے ہے، مکمل production security audit نہیں۔ عوامی ہوسٹنگ سے پہلے authentication، distributed rate limiting، HTTPS، اور deployment configuration کی مزید جانچ کریں۔
