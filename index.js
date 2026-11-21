import dns from "node:dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);

import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(cors({ origin: process.env.CLIENT_URL }));
app.use(express.json());

// database
const client = new MongoClient(process.env.MONGODB_URI);
const db = client.db(process.env.DB_NAME);
const usersCollection = db.collection("users");
const menuItemsCollection = db.collection("menuItems");
const ordersCollection = db.collection("orders");
const transactionsCollection = db.collection("transactions");

async function connectDB() {
  try {
    await client.connect();
    await db.command({ ping: 1 });
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
  }
}
await connectDB();

// Better Auth's public keys, used to check that a JWT is real
const JWKS = createRemoteJWKSet(
  new URL(`${process.env.AUTH_URL}/api/auth/jwks`),
);

// ---------- auth middleware ----------

// 1. Is there a valid, unexpired JWT? Who is it?
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Unauthorized: please sign in" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const { payload } = await jwtVerify(token, JWKS);
    const user = await usersCollection.findOne({
      _id: new ObjectId(payload.sub),
    });

    if (!user) {
      return res.status(401).send({ message: "Unauthorized: user not found" });
    }
    if (user.isBlocked) {
      return res.status(403).send({ message: "Your account has been blocked" });
    }

    req.user = user;
    next();
  } catch {
    return res
      .status(401)
      .send({ message: "Unauthorized: invalid or expired token" });
  }
};

// 2. Role checks (always use AFTER verifyToken)
const verifyAdmin = (req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).send({ message: "Forbidden: admins only" });
  }
  next();
};

const verifyVendor = (req, res, next) => {
  if (req.user.role !== "vendor") {
    return res.status(403).send({ message: "Forbidden: vendors only" });
  }
  next();
};

const verifyCustomer = (req, res, next) => {
  if (req.user.role !== "customer") {
    return res.status(403).send({ message: "Forbidden: customers only" });
  }
  next();
};

// ---------- helpers ----------

const CATEGORIES = [
  "Classic Pizzas",
  "Vegetarian Pizzas",
  "Meat Lovers",
  "Specialty / Gourmet Pizzas",
  "Sides & Appetizers",
  "Beverages & Desserts",
];

const FREE_ITEM_LIMIT = 3;

// turns a string into an ObjectId, or null if it is not a valid id
const toObjectId = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

// premium = paid plan that has not expired
const isPremium = (user) =>
  user.subscriptionPlan === "premium" &&
  (!user.subscriptionExpiresAt ||
    new Date(user.subscriptionExpiresAt) > new Date());

// pending + approved items count as "active" for the free limit
const countActiveItems = (vendorId) =>
  menuItemsCollection.countDocuments({
    vendorId,
    status: { $in: ["pending", "approved"] },
  });

// checks the form data; returns an error message, or null if everything is fine
const validateMenuItem = (body) => {
  const { itemName, category, description, price, location, images } = body;
  if (!itemName || itemName.trim().length < 3)
    return "Item name must be at least 3 characters";
  if (!CATEGORIES.includes(category)) return "Please choose a valid category";
  if (!description || description.trim().length < 10)
    return "Description must be at least 10 characters";
  if (typeof price !== "number" || price <= 0)
    return "Price must be a number greater than 0";
  if (!location || location.trim().length < 2) return "Please enter a location";
  if (!Array.isArray(images) || images.length === 0)
    return "Please upload at least one image";
  return null;
};

// ---------- routes ----------

// ---------- routes ----------

app.get("/", (req, res) => {
  res.send({ message: "PizzaHub server is running" });
});

// who am I? (used to test the JWT)
app.get("/me", verifyToken, (req, res) => {
  const { _id, name, email, role, subscriptionPlan } = req.user;
  res.send({ _id, name, email, role, subscriptionPlan });
});

// ---------- menu items (vendor) ----------

// create a menu item
app.post("/menu-items", verifyToken, verifyVendor, async (req, res) => {
  try {
    const error = validateMenuItem(req.body);
    if (error) return res.status(400).send({ message: error });

    // free plan limit
    if (!isPremium(req.user)) {
      const activeCount = await countActiveItems(req.user._id);
      if (activeCount >= FREE_ITEM_LIMIT) {
        return res.status(403).send({
          message: `Free plan allows only ${FREE_ITEM_LIMIT} active items. Upgrade to Premium for unlimited items.`,
        });
      }
    }

    const { itemName, category, description, price, location, images } =
      req.body;
    const menuItem = {
      vendorId: req.user._id, // from the verified token, never from the form
      itemName: itemName.trim(),
      category,
      description: description.trim(),
      price,
      location: location.trim(),
      images,
      status: "pending",
      createdAt: new Date(),
    };

    const result = await menuItemsCollection.insertOne(menuItem);
    res.status(201).send({
      insertedId: result.insertedId,
      message: "Menu item submitted for review",
    });
  } catch {
    res
      .status(500)
      .send({ message: "Could not save the menu item. Please try again." });
  }
});

app.listen(port, () => {
  console.log(`PizzaHub server running on port ${port}`);
});

export default app;
