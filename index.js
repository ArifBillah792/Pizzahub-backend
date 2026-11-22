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

// helper: find an item that belongs to the logged-in vendor
const findOwnItem = async (id, vendorId) => {
  const _id = toObjectId(id);
  if (!_id) return { status: 404, message: "Menu item not found" };
  const item = await menuItemsCollection.findOne({ _id });
  if (!item) return { status: 404, message: "Menu item not found" };
  if (!item.vendorId.equals(vendorId)) {
    return { status: 403, message: "You can only manage your own menu items" };
  }
  return { item };
};

// my menu items (newest first)
app.get("/menu-items/mine", verifyToken, verifyVendor, async (req, res) => {
  try {
    const items = await menuItemsCollection
      .find({ vendorId: req.user._id })
      .sort({ createdAt: -1 })
      .toArray();
    res.send(items);
  } catch {
    res.status(500).send({ message: "Could not load your menu items" });
  }
});

// one of my items (for the edit page)
app.get("/menu-items/mine/:id", verifyToken, verifyVendor, async (req, res) => {
  try {
    const { item, status, message } = await findOwnItem(
      req.params.id,
      req.user._id,
    );
    if (!item) return res.status(status).send({ message });
    res.send(item);
  } catch {
    res.status(500).send({ message: "Could not load the menu item" });
  }
});

// update my item: it goes back to "pending" so the admin reviews the changes
app.patch("/menu-items/:id", verifyToken, verifyVendor, async (req, res) => {
  try {
    const { item, status, message } = await findOwnItem(
      req.params.id,
      req.user._id,
    );
    if (!item) return res.status(status).send({ message });

    const error = validateMenuItem(req.body);
    if (error) return res.status(400).send({ message: error });

    // a hidden or rejected item becomes active again, so check the free limit
    const wasActive = ["pending", "approved"].includes(item.status);
    if (!wasActive && !isPremium(req.user)) {
      const activeCount = await countActiveItems(req.user._id);
      if (activeCount >= FREE_ITEM_LIMIT) {
        return res.status(403).send({
          message: `Free plan allows only ${FREE_ITEM_LIMIT} active items.`,
        });
      }
    }

    const { itemName, category, description, price, location, images } =
      req.body;
    await menuItemsCollection.updateOne(
      { _id: item._id },
      {
        $set: {
          itemName: itemName.trim(),
          category,
          description: description.trim(),
          price,
          location: location.trim(),
          images,
          status: "pending",
          updatedAt: new Date(),
        },
      },
    );
    res.send({ message: "Menu item updated and sent for review" });
  } catch {
    res.status(500).send({ message: "Could not update the menu item" });
  }
});

// hide (inactive) or show again (approved) one of my items
app.patch(
  "/menu-items/:id/availability",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    try {
      const { available } = req.body;
      if (typeof available !== "boolean") {
        return res
          .status(400)
          .send({ message: "available must be true or false" });
      }

      const { item, status, message } = await findOwnItem(
        req.params.id,
        req.user._id,
      );
      if (!item) return res.status(status).send({ message });

      if (available) {
        if (item.status !== "inactive") {
          return res
            .status(400)
            .send({ message: "Only hidden items can be made available" });
        }
        if (item.inactiveBy === "admin") {
          return res
            .status(403)
            .send({ message: "This item was deactivated by an admin" });
        }
        if (
          !isPremium(req.user) &&
          (await countActiveItems(req.user._id)) >= FREE_ITEM_LIMIT
        ) {
          return res.status(403).send({
            message: `Free plan allows only ${FREE_ITEM_LIMIT} active items.`,
          });
        }
        await menuItemsCollection.updateOne(
          { _id: item._id },
          { $set: { status: "approved" }, $unset: { inactiveBy: "" } },
        );
        return res.send({ message: "Item is available again" });
      }

      if (item.status !== "approved") {
        return res
          .status(400)
          .send({ message: "Only approved items can be hidden" });
      }
      await menuItemsCollection.updateOne(
        { _id: item._id },
        { $set: { status: "inactive", inactiveBy: "vendor" } },
      );
      res.send({ message: "Item hidden from customers" });
    } catch {
      res.status(500).send({ message: "Could not change availability" });
    }
  },
);

// delete my item (its pending orders are cancelled)
app.delete("/menu-items/:id", verifyToken, verifyVendor, async (req, res) => {
  try {
    const { item, status, message } = await findOwnItem(
      req.params.id,
      req.user._id,
    );
    if (!item) return res.status(status).send({ message });

    await menuItemsCollection.deleteOne({ _id: item._id });
    await ordersCollection.updateMany(
      { itemId: item._id, status: "pending" },
      { $set: { status: "cancelled" } },
    );
    res.send({ message: "Menu item deleted" });
  } catch {
    res.status(500).send({ message: "Could not delete the menu item" });
  }
});

// ---------- menu items (public) ----------

// adds the vendor's public info (name, restaurant, photo, plan) to each item
const vendorLookup = [
  {
    $lookup: {
      from: "users",
      localField: "vendorId",
      foreignField: "_id",
      as: "vendor",
    },
  },
  { $unwind: "$vendor" },
  {
    $addFields: {
      "vendor.isPremium": {
        $and: [
          { $eq: ["$vendor.subscriptionPlan", "premium"] },
          { $gt: ["$vendor.subscriptionExpiresAt", "$$NOW"] },
        ],
      },
    },
  },
  {
    $project: {
      itemName: 1,
      category: 1,
      description: 1,
      price: 1,
      location: 1,
      images: 1,
      status: 1,
      createdAt: 1,
      vendorId: 1,
      "vendor.name": 1,
      "vendor.businessName": 1,
      "vendor.image": 1,
      "vendor.isPremium": 1,
    },
  },
];

// browse: only approved items, with search, filters and sorting
app.get("/menu-items", async (req, res) => {
  try {
    const { search, category, location, sort } = req.query;
    const match = { status: "approved" };

    if (search) match.itemName = { $regex: search, $options: "i" };
    if (category && CATEGORIES.includes(category)) match.category = category;
    if (location) match.location = { $regex: location, $options: "i" };

    const sortBy =
      sort === "price_asc"
        ? { price: 1 }
        : sort === "price_desc"
          ? { price: -1 }
          : { createdAt: -1 };

    const items = await menuItemsCollection
      .aggregate([{ $match: match }, { $sort: sortBy }, ...vendorLookup])
      .toArray();
    res.send(items);
  } catch {
    res.status(500).send({ message: "Could not load the menu" });
  }
});

// home page: approved items, Premium vendors first
app.get("/menu-items/featured", async (req, res) => {
  try {
    const items = await menuItemsCollection
      .aggregate([
        { $match: { status: "approved" } },
        ...vendorLookup,
        { $sort: { "vendor.isPremium": -1, createdAt: -1 } },
        { $limit: 8 },
      ])
      .toArray();
    res.send(items);
  } catch {
    res.status(500).send({ message: "Could not load featured items" });
  }
});

// item details: only approved items
app.get("/menu-items/:id", async (req, res) => {
  try {
    const _id = toObjectId(req.params.id);
    if (!_id)
      return res.status(404).send({ message: "This menu item does not exist" });

    const [item] = await menuItemsCollection
      .aggregate([{ $match: { _id, status: "approved" } }, ...vendorLookup])
      .toArray();

    if (!item)
      return res
        .status(404)
        .send({ message: "This menu item does not exist or is not available" });
    res.send(item);
  } catch {
    res.status(500).send({ message: "Could not load the menu item" });
  }
});

// ---------- orders ----------

const ORDER_LOOKUPS = [
  {
    $lookup: {
      from: "menuItems",
      localField: "itemId",
      foreignField: "_id",
      as: "item",
    },
  },
  { $unwind: { path: "$item", preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: "users",
      localField: "vendorId",
      foreignField: "_id",
      as: "vendor",
    },
  },
  { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: "users",
      localField: "customerId",
      foreignField: "_id",
      as: "customer",
    },
  },
  { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } },
  {
    $project: {
      deliveryDate: 1,
      deliveryAddress: 1,
      message: 1,
      status: 1,
      createdAt: 1,
      updatedAt: 1,
      "item._id": 1,
      "item.itemName": 1,
      "item.images": 1,
      "item.price": 1,
      "vendor.name": 1,
      "vendor.businessName": 1,
      "customer.name": 1,
      "customer.email": 1,
      "customer.image": 1,
    },
  },
];

// customer places an order
app.post("/orders", verifyToken, verifyCustomer, async (req, res) => {
  try {
    const { itemId, deliveryDate, deliveryAddress, message = "" } = req.body;

    const _itemId = toObjectId(itemId);
    if (!_itemId)
      return res.status(404).send({ message: "Menu item not found" });

    const item = await menuItemsCollection.findOne({
      _id: _itemId,
      status: "approved",
    });
    if (!item)
      return res
        .status(404)
        .send({ message: "This item is not available for ordering" });

    if (item.vendorId.equals(req.user._id)) {
      return res
        .status(403)
        .send({ message: "You cannot order your own item" });
    }

    // delivery date: a real date, today or later
    const date = new Date(`${deliveryDate}T00:00:00.000Z`);
    const today = new Date(
      new Date().toISOString().slice(0, 10) + "T00:00:00.000Z",
    );
    if (!deliveryDate || isNaN(date))
      return res.status(400).send({ message: "Please choose a delivery date" });
    if (date < today)
      return res
        .status(400)
        .send({ message: "Delivery date cannot be in the past" });

    if (!deliveryAddress || deliveryAddress.trim().length < 5) {
      return res
        .status(400)
        .send({ message: "Please enter a full delivery address" });
    }
    if (message.length > 300)
      return res
        .status(400)
        .send({ message: "Message must be 300 characters or less" });

    // no duplicate active order for the same item and date
    const duplicate = await ordersCollection.findOne({
      itemId: _itemId,
      customerId: req.user._id,
      deliveryDate: date,
      status: { $in: ["pending", "accepted"] },
    });
    if (duplicate) {
      return res.status(409).send({
        message: "You already have an active order for this item on that date",
      });
    }

    const order = {
      itemId: _itemId,
      vendorId: item.vendorId,
      customerId: req.user._id,
      deliveryDate: date,
      deliveryAddress: deliveryAddress.trim(),
      message: message.trim(),
      status: "pending",
      createdAt: new Date(),
    };
    const result = await ordersCollection.insertOne(order);
    res.status(201).send({
      insertedId: result.insertedId,
      message: "Order placed successfully",
    });
  } catch {
    res
      .status(500)
      .send({ message: "Could not place the order. Please try again." });
  }
});

// customer: my orders
app.get("/orders/mine", verifyToken, verifyCustomer, async (req, res) => {
  try {
    const orders = await ordersCollection
      .aggregate([
        { $match: { customerId: req.user._id } },
        { $sort: { createdAt: -1 } },
        ...ORDER_LOOKUPS,
      ])
      .toArray();
    res.send(orders);
  } catch {
    res.status(500).send({ message: "Could not load your orders" });
  }
});

// customer: cancel my pending order
app.patch(
  "/orders/:id/cancel",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return res.status(404).send({ message: "Order not found" });

      const order = await ordersCollection.findOne({ _id });
      if (!order) return res.status(404).send({ message: "Order not found" });
      if (!order.customerId.equals(req.user._id)) {
        return res
          .status(403)
          .send({ message: "You can only cancel your own orders" });
      }
      if (order.status !== "pending") {
        return res.status(400).send({
          message: `This order is already ${order.status} and cannot be cancelled`,
        });
      }

      await ordersCollection.updateOne(
        { _id },
        { $set: { status: "cancelled", updatedAt: new Date() } },
      );
      res.send({ message: "Order cancelled" });
    } catch {
      res.status(500).send({ message: "Could not cancel the order" });
    }
  },
);

// vendor: orders for my items
app.get("/orders/vendor", verifyToken, verifyVendor, async (req, res) => {
  try {
    const orders = await ordersCollection
      .aggregate([
        { $match: { vendorId: req.user._id } },
        { $sort: { createdAt: -1 } },
        ...ORDER_LOOKUPS,
      ])
      .toArray();
    res.send(orders);
  } catch {
    res.status(500).send({ message: "Could not load customer orders" });
  }
});

// vendor: accept or reject a pending order (only once)
app.patch("/orders/:id/status", verifyToken, verifyVendor, async (req, res) => {
  try {
    const { status } = req.body;
    if (!["accepted", "rejected"].includes(status)) {
      return res
        .status(400)
        .send({ message: "Status must be accepted or rejected" });
    }

    const _id = toObjectId(req.params.id);
    if (!_id) return res.status(404).send({ message: "Order not found" });

    const order = await ordersCollection.findOne({ _id });
    if (!order) return res.status(404).send({ message: "Order not found" });
    if (!order.vendorId.equals(req.user._id)) {
      return res
        .status(403)
        .send({ message: "You can only manage orders for your own items" });
    }
    if (order.status !== "pending") {
      return res
        .status(400)
        .send({ message: `This order is already ${order.status}` });
    }

    await ordersCollection.updateOne(
      { _id },
      { $set: { status, updatedAt: new Date() } },
    );
    res.send({ message: `Order ${status}` });
  } catch {
    res.status(500).send({ message: "Could not update the order" });
  }
});

// ---------- admin ----------

// all menu items (any status), with search and filters
app.get("/admin/menu-items", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { search, status, category } = req.query;
    const match = {};
    if (search) match.itemName = { $regex: search, $options: "i" };
    if (["pending", "approved", "rejected", "inactive"].includes(status))
      match.status = status;
    if (category && CATEGORIES.includes(category)) match.category = category;

    const items = await menuItemsCollection
      .aggregate([
        { $match: match },
        { $sort: { createdAt: -1 } },
        ...vendorLookup,
      ])
      .toArray();
    res.send(items);
  } catch {
    res.status(500).send({ message: "Could not load menu items" });
  }
});

// approve, reject, deactivate or reactivate an item
app.patch(
  "/admin/menu-items/:id/status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { status } = req.body;
      if (!["approved", "rejected", "inactive"].includes(status)) {
        return res.status(400).send({ message: "Invalid status" });
      }
      const _id = toObjectId(req.params.id);
      if (!_id) return res.status(404).send({ message: "Menu item not found" });

      const item = await menuItemsCollection.findOne({ _id });
      if (!item)
        return res.status(404).send({ message: "Menu item not found" });

      const update =
        status === "inactive"
          ? { $set: { status, inactiveBy: "admin" } }
          : { $set: { status }, $unset: { inactiveBy: "" } };
      await menuItemsCollection.updateOne({ _id }, update);
      res.send({ message: `Item ${status}` });
    } catch {
      res.status(500).send({ message: "Could not update the item" });
    }
  },
);

// delete an inappropriate item
app.delete(
  "/admin/menu-items/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return res.status(404).send({ message: "Menu item not found" });

      const result = await menuItemsCollection.deleteOne({ _id });
      if (result.deletedCount === 0)
        return res.status(404).send({ message: "Menu item not found" });

      await ordersCollection.updateMany(
        { itemId: _id, status: "pending" },
        { $set: { status: "cancelled" } },
      );
      res.send({ message: "Menu item deleted" });
    } catch {
      res.status(500).send({ message: "Could not delete the item" });
    }
  },
);

// all users, with search by name or email and filter by role
app.get("/admin/users", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { search, role } = req.query;
    const query = {};
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }
    if (["admin", "vendor", "customer"].includes(role)) query.role = role;

    const users = await usersCollection
      .find(query, {
        projection: {
          name: 1,
          email: 1,
          image: 1,
          role: 1,
          businessName: 1,
          subscriptionPlan: 1,
          subscriptionExpiresAt: 1,
          isBlocked: 1,
          createdAt: 1,
        },
      })
      .sort({ createdAt: -1 })
      .toArray();
    res.send(users);
  } catch {
    res.status(500).send({ message: "Could not load users" });
  }
});

// all transactions (read-only: there is no route to edit them)
app.get("/admin/transactions", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const transactions = await transactionsCollection
      .aggregate([
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: "users",
            localField: "vendorId",
            foreignField: "_id",
            as: "vendor",
          },
        },
        { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            plan: 1,
            amount: 1,
            currency: 1,
            status: 1,
            createdAt: 1,
            "vendor.name": 1,
            "vendor.email": 1,
            "vendor.businessName": 1,
          },
        },
      ])
      .toArray();
    res.send(transactions);
  } catch {
    res.status(500).send({ message: "Could not load transactions" });
  }
});

app.listen(port, () => {
  console.log(`PizzaHub server running on port ${port}`);
});

export default app;
