# SAROUR STORE — Render Ready

এই ZIP এখন TeleBotHost-এর জন্য নয়। এটি Render Web Service-এ চালানোর জন্য Node.js project।

## Included features

- Sarour Store branding
- Owner ID: 8179643564
- Support: @Sarour99
- Group: @sarourstore
- Channel: @sarourstors
- `/start` + persistent keyboard
- Direct green product buttons: Product | BDT price | stock
- Live supplier product sync
- Customer price = supplier USDT price × USD-to-BDT rate + fixed BDT markup
- Default markup = ৳50
- Balance
- Deposit request + admin Approve/Reject
- Referral
- My Orders
- Automatic supplier purchase and delivery
- Manual pending order delivery
- Button-only Admin Panel
- Add/edit/hide/delete manual products
- User balance add/remove from Admin Panel
- Add/remove one extra owner
- Store settings from buttons
- Automatic product sync

## Render setup

### 1. Upload to GitHub

Extract this ZIP and upload all files in `SAROUR_STORE_RENDER_READY` to a GitHub repository.

Required root files:

- `index.js`
- `package.json`
- `render.yaml`
- `.env.example`

### 2. Render

Render Dashboard → New → Web Service → connect the GitHub repository.

If Render reads `render.yaml`, most settings are already provided.

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

Health check:

```text
/health
```

### 3. Environment variables

You MUST add:

```text
BOT_TOKEN = BotFather token
SUPPLIER_API_KEY = your tgb_live_ API key
```

Already configured in the project defaults:

```text
OWNER_ID=8179643564
SUPPORT_USERNAME=@Sarour99
GROUP_USERNAME=@sarourstore
CHANNEL_USERNAME=@sarourstors
PROFIT_MARKUP_BDT=50
```

Set your own current conversion rate:

```text
USD_TO_BDT=120
```

You can also change USD rate and markup later from:

```text
Admin Panel → Store Settings
```

### 4. Deposit

Set these Render Environment Variables or set them later from Admin Panel:

```text
DEPOSIT_METHOD=bKash
DEPOSIT_ACCOUNT=01XXXXXXXXX
MIN_DEPOSIT_BDT=50
```

User flow:

```text
Deposit → amount → payment details → transaction/reference ID
```

Admin flow:

```text
Admin Panel → Deposit Requests → request → Approve/Reject
```

Approve করলে user balance automatic যোগ হবে।

## Important: persistent data

Balance, deposits and orders are important data.

If `DATABASE_URL` is set, the bot stores its state in PostgreSQL.

Without `DATABASE_URL`, it stores data in:

```text
./data/store.json
```

Render's normal filesystem is ephemeral across deploys. For real usage, use a persistent PostgreSQL database or attach a Render persistent disk and set:

```text
DATA_DIR=/var/data
```

Do not put BOT_TOKEN or SUPPLIER_API_KEY in GitHub/source code.

## Product price

Supplier product price is kept privately in USDT.

Customer sees:

```text
Supplier Price × USD_TO_BDT + PROFIT_MARKUP_BDT
```

Example:

```text
Supplier = 1 USDT
USD_TO_BDT = 120
Markup = 50
Customer price = ৳170
```

## Admin Panel

No slash command is required for admin management.

Buttons include:

- Sync Products
- Store Wallet
- Add Product
- Product Manager
- Order Manager
- Deposit Requests
- User Balance
- Sales Report
- Store Settings
- Owner Access

Text is only requested when a value genuinely needs to be entered, such as a price, user ID, deposit account, product name, or delivery content.
