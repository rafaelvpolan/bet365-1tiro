
import { connection, Schema, Document } from 'mongoose'

const database:any = connection.useDb('bet365')

export interface IBets extends Document {
  sport:string,
  championship:string,
  date:string,
  time:string,
  datetime:string,
  timestamp:Date,
  timezone:string | any,
  teamOne:string,
  teamTwo:string,
  teamWin:string,
  totalGoals:number,
  score:string           
}

const schema = new Schema<IBets>({
  sport:String,
  championship:String,
  date:{type:String, unique: true},
  time:String,
  datetime:{type:String, unique: true},
  timestamp:{type:Date, unique: true},
  timezone:String,
  teamOne:String,
  teamTwo:String,
  teamWin:String,
  totalGoals:Number,
  score:String             
  
}, { collection: 'bets', timestamps: true })


schema.pre('save', async function(next)  {

  const find = !!database.model('Bets').findOne({championship:this.championship,timestamp:this.datetime})
  
  if(!find){
    next()
  }

})


const Model = database.model('Bets', schema)
export default Model


