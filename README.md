🍕 PizzaHub — Server (Express + MongoDB)

The REST API for PizzaHub, a pizza ordering and delivery platform with three roles: customer, vendor and admin. It handles menu items, orders, admin moderation, statistics and Stripe subscriptions.

Live API: https://pizzahub-backend.vercel.app
Live site: https://pizzahub-frontend-alpha.vercel.app
Client repo: https://github.com/ArifBillah792/Pizzahub-frontend
Server repo: https://github.com/ArifBillah792/Pizzahub-backend
🛠️ Tech Stack & npm Packages
Package	Used for
express (v5)	Server and routing
mongodb	Native MongoDB driver
cors	Allow requests only from the client URL
dotenv	Environment variables
jose	Verify Better Auth JWTs with the remote JWKS
stripe	Subscription checkout and webhooks

Collections: users (created by Better Auth), menuItems, orders, transactions.

🔐 JWT Middleware Flow
The client sends Authorization: Bearer <token>.
verifyToken checks the token with jose (jwtVerify + createRemoteJWKSet from AUTH_URL/api/auth/jwks).
It loads the user from MongoDB using the token's sub. Blocked users get 403.
Role middlewares verifyCustomer, verifyVendor and verifyAdmin return 403 for the wrong role.
Routes also check ownership (a vendor can only change their own items and orders).

Missing or invalid token → 401 · wrong role → 403.

📡 API Endpoints
Public
Method	Route	Description
GET	/menu-items	Approved items with search, filter and sort
GET	/menu-items/featured	Featured items, Premium vendors first
GET	/menu-items/:id	Single approved item with vendor info
Logged-in user
Method	Route	Description
GET	/me	Current user, role and plan
GET	/orders/:id	Order details (owner customer, vendor or admin)
Vendor
Method	Route	Description
POST	/menu-items	Add an item (Free plan: max 3 active items)
GET	/menu-items/mine	My items
GET	/menu-items/mine/:id	One of my items
PATCH	/menu-items/:id	Edit an item (goes back to pending)
PATCH	/menu-items/:id/availability	Show or hide an item
DELETE	/menu-items/:id	Delete an item (its pending orders are cancelled)
GET	/orders/vendor	Orders for my items
PATCH	/orders/:id/status	Accept or reject a pending order
POST	/subscriptions/checkout	Start Stripe Premium checkout
POST	/subscriptions/cancel	Cancel Premium at the end of the period
GET	/stats/vendor	Vendor overview stats
Customer
Method	Route	Description
POST	/orders	Place an order (validated, duplicate check → 409)
GET	/orders/mine	My orders
PATCH	/orders/:id/cancel	Cancel a pending order
GET	/stats/customer	Customer overview stats
Admin
Method	Route	Description
GET	/admin/menu-items	All menu items
PATCH	/admin/menu-items/:id/status	Approve, reject or deactivate
DELETE	/admin/menu-items/:id	Delete an item
GET	/admin/users	Users with search and role filter
GET	/admin/transactions	All payments (read only)
GET	/stats/admin	Platform stats
Stripe
Method	Route	Description
POST	/stripe/webhook	Signed Stripe webhook (raw body)
🔍 Search, Filter & Sort

GET /menu-items?search=pepperoni&category=Pizza&location=Dhaka&sort=price_asc

search → MongoDB $regex (case-insensitive) on the name
category, location → added to the query only when sent
sort → price_asc or price_desc
Vendor info is joined with an aggregation $lookup
💳 Stripe Subscription & Webhook
A vendor clicks Upgrade → POST /subscriptions/checkout creates a Stripe Checkout session in subscription mode.
After payment, Stripe calls POST /stripe/webhook. The route uses express.raw() and stripe.webhooks.constructEvent to verify the signature.
The webhook is the only place that activates Premium:
checkout.session.completed → saves the transaction and sets subscriptionPlan: "premium" with subscriptionExpiresAt
customer.subscription.updated → updates the expiry date
customer.subscription.deleted → returns the vendor to the Free plan

Test card: 4242 4242 4242 4242, any future date, any CVC.

⚙️ Environment Variables

Create a .env file (see .env.example):

PORT=5000
MONGODB_URI=
DB_NAME=
CLIENT_URL=http://localhost:3000
AUTH_URL=http://localhost:3000
STRIPE_SECRET_KEY=
STRIPE_PRICE_ID=
STRIPE_WEBHOOK_SECRET=
🚀 Run Locally
bash
git clone https://github.com/ArifBillah792/Pizzahub-backend.git
cd Pizzahub-backend
npm install
npm run dev

The server runs on http://localhost:5000.