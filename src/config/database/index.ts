import { connect, disconnect, ConnectOptions } from 'mongoose'

require('dotenv').config()

export const MongoDbConnect = async () => {
  const hostConnection = `${process.env.MONGODB_HOST}`
  try {
    await connect(hostConnection, <ConnectOptions>{
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('Connected to MongoDB!!!')
  } catch (err) {
    console.log('Failed to connect to MongoDB', err);
  }

}
export const MongoDbDisconnect = () => {
  disconnect();
}
