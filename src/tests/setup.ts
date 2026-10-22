import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db';

beforeAll(async () => {
  await connectDb();
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDb();
});
