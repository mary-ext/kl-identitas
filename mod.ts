import { InvalidRequestError, json, XRPCRouter } from '@atcute/xrpc-server';
import { cors } from '@atcute/xrpc-server/middlewares/cors';
import { Client, ok } from '@atcute/client';

import type { Did, Handle } from '@atcute/lexicons';
import { isDid } from '@atcute/lexicons/syntax';

import {
	ComAtprotoIdentityResolveDid,
	ComAtprotoIdentityResolveHandle,
	ComAtprotoIdentityResolveIdentity,
} from '@atcute/atproto';

import { type DidDocument, getAtprotoHandle } from '@atcute/identity';
import {
	AmbiguousHandleError,
	CompositeDidDocumentResolver,
	CompositeHandleResolver,
	DidNotFoundError,
	DocumentNotFoundError,
	DohJsonHandleResolver,
	ImproperDidError,
	InvalidResolvedHandleError,
	PlcDidDocumentResolver,
	UnsupportedDidMethodError,
	WebDidDocumentResolver,
	WellKnownHandleResolver,
} from '@atcute/identity-resolver';

const handleResolver = new CompositeHandleResolver({
	methods: {
		dns: new DohJsonHandleResolver({ dohUrl: 'https://mozilla.cloudflare-dns.com/dns-query' }),
		http: new WellKnownHandleResolver(),
	},
});

const didDocResolver = new CompositeDidDocumentResolver<string>({
	methods: {
		plc: new PlcDidDocumentResolver(),
		web: new WebDidDocumentResolver(),
	},
});

const cache = await caches.open('default');

const router = new XRPCRouter({
	middlewares: [
		cors(),
		async (request, next) => {
			let response = await cache.match(request);
			if (response === undefined) {
				response = await next(request);

				if (response.status === 200 && response.headers.has('cache-control')) {
					await cache.put(request, response.clone());
				}
			}

			return response;
		},
	],
});

const client = new Client({
	handler(pathname, init) {
		return router.fetch(new Request(new URL(pathname, 'http://localhost'), init));
	},
});

const resolveHandleToDid = async (handle: Handle): Promise<Did> => {
	try {
		const did = await handleResolver.resolve(handle);

		return did;
	} catch (err) {
		console.error(`resolveHandleToDid`, handle, err);

		if (err instanceof DidNotFoundError) {
			throw new InvalidRequestError({ description: `no did found under that handle` });
		}

		if (err instanceof InvalidResolvedHandleError) {
			throw new InvalidRequestError({ description: `did found but is invalid atproto did` });
		}

		if (err instanceof AmbiguousHandleError) {
			throw new InvalidRequestError({ description: `multiple did found under that handle` });
		}

		throw err;
	}
};

const resolveDidToDoc = async (did: Did): Promise<DidDocument> => {
	try {
		const doc = await didDocResolver.resolve(did);

		return doc;
	} catch (err) {
		console.error(`resolveDidToDoc`, did, err);

		if (err instanceof DocumentNotFoundError) {
			throw new InvalidRequestError({ description: `no document found under that did` });
		}

		if (err instanceof UnsupportedDidMethodError) {
			throw new InvalidRequestError({ description: `unsupported did method` });
		}

		if (err instanceof ImproperDidError) {
			throw new InvalidRequestError({ description: `invalid did` });
		}

		throw err;
	}
};

router.add(ComAtprotoIdentityResolveHandle.mainSchema, {
	async handler({ params: { handle } }) {
		const did = await resolveHandleToDid(handle);

		return json(
			{ did },
			{ headers: { 'cache-control': 'public, max-age=600' } },
		);
	},
});

router.add(ComAtprotoIdentityResolveDid.mainSchema, {
	async handler({ params: { did } }) {
		const doc = await resolveDidToDoc(did);

		return json(
			{ didDoc: doc as unknown as Record<string, unknown> },
			{ headers: { 'cache-control': 'public, max-age=3600' } },
		);
	},
});

router.add(ComAtprotoIdentityResolveIdentity.mainSchema, {
	async handler({ params: { identifier } }) {
		const identifierIsDid = isDid(identifier);

		let did: Did;
		if (identifierIsDid) {
			did = identifier;
		} else {
			const resolved = await ok(
				client.get('com.atproto.identity.resolveHandle', {
					params: {
						handle: identifier,
					},
				}),
			);

			did = resolved.did;
		}

		let doc: DidDocument;
		{
			const resolved = await ok(
				client.get('com.atproto.identity.resolveDid', {
					params: {
						did: did,
					},
				}),
			);

			doc = resolved.didDoc as unknown as DidDocument;
		}

		let handle: Handle;
		let handleIsValid: boolean;
		if (identifierIsDid) {
			const writtenHandle = getAtprotoHandle(doc);
			if (writtenHandle) {
				handle = writtenHandle;

				try {
					const resolved = await ok(
						client.get('com.atproto.identity.resolveHandle', {
							params: {
								handle: handle,
							},
						}),
					);

					handleIsValid = did === resolved.did;
				} catch {
					handleIsValid = false;
				}
			} else {
				handle = 'handle.invalid';
				handleIsValid = false;
			}
		} else {
			handle = identifier;
			handleIsValid = getAtprotoHandle(doc) === identifier;
		}

		return json(
			{
				did: did,
				didDoc: doc as unknown as Record<string, unknown>,
				handle: handleIsValid ? handle : 'handle.invalid',
			},
			{ headers: { 'cache-control': 'public, max-age=600' } },
		);
	},
});

export default { fetch: router.fetch } satisfies Deno.ServeDefaultExport;
