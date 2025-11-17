# Quick Start - Deploy to Render

## 🚀 Fast Track Deployment (5 minutes)

### Step 1: Push to GitHub
```bash
git add .
git commit -m "Ready for Render deployment"
git push origin main
```

### Step 2: Deploy on Render

1. **Go to Render Dashboard**
   - Visit: https://dashboard.render.com/blueprints
   - Click "New Blueprint Instance"

2. **Connect Repository**
   - Select your GitHub repository
   - Render will detect `render.yaml` automatically
   - Click "Apply"

3. **Add Environment Variables**
   
   Copy these into each service when prompted:

   ```env
   # Firebase Configuration
   FIREBASE_PROJECT_ID=your-project-id
   FIREBASE_CLIENT_EMAIL=your-service-account@project.iam.gserviceaccount.com
   FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
   FIREBASE_DATABASE_URL=https://your-project.firebaseio.com/
   
   # Telegram Bots
   SUBSCRIPTION_BOT_TOKEN=your-subscription-bot-token
   TELEGRAM_API_ID=your-telegram-api-id
   TELEGRAM_API_HASH=your-telegram-api-hash
   TELEGRAM_SESSION_STRING=your-session-string
   
   # Payment Gateway
   OXAPAY_API_KEY=your-oxapay-api-key
   OXAPAY_MERCHANT_API_KEY=your-merchant-key
   ```

4. **Click "Create Blueprint"**
   - All 3 services deploy automatically
   - Wait 2-3 minutes for deployment

### Step 3: Get Your URL

After deployment:
```
https://shuffle-api-server.onrender.com
```

### Step 4: Update Userscript

Replace the URL in `ShuffleCodeClaimer.user.js`:
```javascript
const API_URL = 'https://shuffle-api-server.onrender.com';
```

## ✅ Verify Deployment

Test your API:
```bash
curl https://shuffle-api-server.onrender.com/health
```

Should return:
```json
{
  "status": "ok",
  "timestamp": "2025-11-17T...",
  "service": "shuffle-api-server"
}
```

## 📊 Monitor Services

- **API Server**: https://dashboard.render.com/web/shuffle-api-server
- **Subscription Bot**: https://dashboard.render.com/worker/shuffle-subscription-bot
- **Telegram Bot**: https://dashboard.render.com/worker/shuffle-telegram-bot

## 🔧 Common Issues

### Services Won't Start
- Check environment variables are set correctly
- View logs in Render dashboard
- Verify Firebase credentials

### Build Fails
- Ensure `package.json` has all dependencies
- Check Node version (20.x)
- Review build logs for errors

### Can't Connect
- Wait 30-60 seconds after first deploy
- Services spin down on free tier (15 min inactivity)
- First request after sleep takes longer

## 💡 Tips

1. **Free Tier Sleep**: Services sleep after 15 minutes. First request wakes them up (30-60s delay)
2. **Auto-Deploy**: Every git push triggers automatic deployment
3. **Logs**: Real-time logs available in dashboard
4. **Scaling**: Upgrade to Starter plan ($7/mo) to keep services awake 24/7

## 📚 Need More Help?

See full guide: [RENDER_DEPLOYMENT.md](./RENDER_DEPLOYMENT.md)
