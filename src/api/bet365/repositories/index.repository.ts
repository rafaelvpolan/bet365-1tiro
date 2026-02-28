import BetsModel, { IBets } from '../models/bets.model'
import mongoose from 'mongoose'
import { AwaitExpression, AwaitKeyword, isLiteralExpression } from 'typescript'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GenericObject = { [key: string]: any }

class Bet365Repository {
  public async find (params: GenericObject) : Promise<Array<IBets>> {
    const options = {
      find: params.find || {},
      sort: params.sort || {},
      limit: params.limit || 0,
      select: params.select || ''
    }

    const query = BetsModel.find(options.find)

    if (options.select) { query.select(options.select) }
    if (options.sort) { query.sort(options.sort) }
    if (options.limit) { query.limit(options.limit) }
    return query
  }

  public async findById (id: string) : Promise<GenericObject> {
    return await BetsModel.findOne({ _id: id })
  }

  public async save (body: IBets) : Promise<GenericObject> {
    let result = null
    let exist = null
    const id = body._id || null
    if (id) { exist = await BetsModel.findOne({ _id: id }) }
    if (exist) {      
      result = await BetsModel.updateOne({ _id: id }, body)
    } else {     
      result = await BetsModel.create(body)
    }

    return result
  }

  public async delete (body: GenericObject) : Promise<GenericObject> {
    const result = await BetsModel.deleteOne({ _id: body._id })
    return result
  }


}
export default new Bet365Repository()
