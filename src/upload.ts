/** Uploads file to blob store. */

import * as Busboy from 'busboy'
import * as config from 'config'
import {createHash} from 'crypto'
import {Client, Signature} from 'dsteem'
import * as http from 'http'
import * as Koa from 'koa'
import * as multihash from 'multihashes'
import {URL} from 'url'

import {rpcClient} from './common'
import {APIError} from './error'
import {store} from './store'
import {readStream} from './utils'

const SERVICE_URL = new URL(config.get('service_url'))
const MAX_UPLOAD_SIZE = Number.parseInt(config.get('max_upload_size'))
if (!Number.isFinite(MAX_UPLOAD_SIZE)) {
    throw new Error('Invalid max upload size')
}

if (new URL('http://blä.se').toString() !== 'http://xn--bl-wia.se/') {
    throw new Error('Incompatible node.js version, must be compiled with ICU support')
}

/**
 * Parse multi-part request and return first file found.
 */
async function parseMultipart(request: http.IncomingMessage) {
    return new Promise<{stream: NodeJS.ReadableStream, mime: string, name: string}>((resolve, reject) => {
        const form = new Busboy({
            headers: request.headers,
            limits: {
                files: 1,
                fileSize: MAX_UPLOAD_SIZE,
            }
        })
        form.on('file', (field, stream, name, encoding, mime) => {
            resolve({stream, mime, name})
        })
        form.on('error', reject)
        form.on('finish', () => {
            reject(new APIError({code: APIError.Code.FileMissing}))
        })
        request.pipe(form)
    })
}

export async function uploadHandler(ctx: Koa.Context) {
    ctx.tag({handler: 'upload'})

    APIError.assert(ctx.method === 'POST', {code: APIError.Code.InvalidMethod})
    APIError.assertParams(ctx.params, ['username', 'signature'])

    let signature: Signature
    try {
        signature = Signature.fromString(ctx.params['signature'])
    } catch (cause) {
        throw new APIError({code: APIError.Code.InvalidSignature, cause})
    }

    APIError.assert(ctx.get('content-type').includes('multipart/form-data'),
                    {message: 'Only multipart uploads are supported'})

    const contentLength = Number.parseInt(ctx.get('content-length'))

    APIError.assert(Number.isFinite(contentLength),
                    APIError.Code.LengthRequired)

    APIError.assert(contentLength <= MAX_UPLOAD_SIZE,
                    APIError.Code.PayloadTooLarge)

    const file = await parseMultipart(ctx.req)
    const data = await readStream(file.stream)

    // extra check if client manges to lie about the content-length
    APIError.assert((file.stream as any).truncated !== true,
                    APIError.Code.PayloadTooLarge)

    const imageHash = createHash('sha256')
        .update('ImageSigningChallenge')
        .update(data)
        .digest()

    const [account] = await rpcClient.database.getAccounts([ctx.params['username']])
    APIError.assert(account, APIError.Code.NoSuchAccount)

    let validSignature = false
    const publicKey = signature.recover(imageHash).toString()
    const threshold = account.posting.weight_threshold
    for (const auth of account.posting.key_auths) {
        if (auth[0] === publicKey && auth[1] >= threshold) {
            validSignature = true
            break
        }
    }

    APIError.assert(validSignature, APIError.Code.InvalidSignature)

    // TODO: account-based rate limiting
    // TODO: account karma check
    // TODO: account blacklist

    const key = 'D' + multihash.toB58String(multihash.encode(imageHash, 'sha2-256'))
    const url = new URL(`${ key }/${ file.name }`, SERVICE_URL)

    await store.write(key, data)

    ctx.log.info({account: account.name}, 'uploaded %s', url)

    ctx.status = 200
    ctx.body = {url}
}