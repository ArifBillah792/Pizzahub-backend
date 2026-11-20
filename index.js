import dns from "node:dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);


import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient } from "mongodb";

const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(cors({ origin: process.env.CLIENT_URL }));
app.use(express.json());

// database
const client = new MongoClient(process.env.MONGODB_URI);
const db = client.db(process.env.DB_NAME);

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

// test route
app.get("/", (req, res) => {
  res.send({ message: "PizzaHub server is running" });
});

app.listen(port, () => {
  console.log(`PizzaHub server running on port ${port}`);
});

export default app;
