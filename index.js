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

// ---------- routes ----------

app.get("/", (req, res) => {
  res.send({ message: "PizzaHub server is running" });
});

// who am I? (used to test the JWT)
app.get("/me", verifyToken, (req, res) => {
  const { _id, name, email, role, subscriptionPlan } = req.user;
  res.send({ _id, name, email, role, subscriptionPlan });
});

app.listen(port, () => {
  console.log(`PizzaHub server running on port ${port}`);
});

export default app;
