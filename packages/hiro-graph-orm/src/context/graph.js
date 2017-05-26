/**
 *  The Graph interaction methods.
 *
 *  These wrap the base methods, the gremlin relation queries,
 *  the context and entity definitions to produce Vertex objects
 *  from queries.
 */
import { notFound, badRequest } from "hiro-graph-client/lib/errors";
import { decodeResults, filter, mapIfArray } from "../utils";
import parseLucene from "../lucene";
import { createVertex, isVertex } from "../vertex/graph";

//this is not in utils, so utils doesn't need to import GraphVertex
const createVertices = ctx => mapIfArray(data => createVertex(data, ctx));

//this is a pipeline of a few functions.
//first decode results, then filter empties, then turn to vertexes.
//the ctx._schema.get() with no arg is the internal entity, used
//when we don't know the type in advance
/**
 * @ignore
 */
export const vertexize = (ctx, entity = ctx._schema.get()) => input => {
    return Promise.resolve(input)
        .then(decodeResults(ctx, entity))
        .then(filter(Boolean))
        .then(createVertices(ctx));
};

//this is for results that expect a single result.
const returnOneOrThrow = result => {
    if (!result || result.length === 0) {
        throw notFound("single vertex not found");
    }
    return Array.isArray(result) ? result[0] : result;
};

/**
 * @ignore
 */
export function find(ctx, entity, query, options = {}) {
    const { querystring, placeholders } = parseLucene(query, entity);
    const luceneOptions = Object.assign({}, options, placeholders);
    return ctx._connection
        .lucene(querystring, luceneOptions)
        .then(vertexize(ctx, entity));
}

/**
 * @ignore
 */
export function findOne(ctx, entity, query, options = {}) {
    return find(ctx, entity, query, options).then(returnOneOrThrow);
}

//this function return the response from the callback
// in which ever case.
const noop = () => {};
const cacheCheck = (
    entity,
    cache,
    id,
    { isCached = noop, isCachedButWrongType = noop, notCached = noop }
) => {
    const cached = cache.get(id);
    //the second check is in case errors or something else get in the cache
    if (!cached || !isVertex(cached)) {
        return notCached(id);
    }
    if (entity && !entity.internal && entity.name !== cached.type()) {
        return isCachedButWrongType(cached);
    }
    return isCached(cached);
};

//get Me is a little different as we have no ID to start with,
//but we will get an "ogit/Person" node.
/**
 * @ignore
 */
export function fetchMe(ctx) {
    const entity = ctx.getEntity("ogit/Person");
    return ctx._connection
        .me()
        .then(vertexize(ctx, entity))
        .then(returnOneOrThrow);
}

//find by ID can do multiple things.
//first it can be given either one or many ids.
//also if entity is null, we should use the IDs query.
/**
 * @ignore
 */
export function findById(ctx, entity, query, options = {}) {
    if (Array.isArray(query)) {
        //do an ids query.
        const cached = [];
        let toFetch;
        if (!options.refetch) {
            const callbacks = {
                isCached: vertex => {
                    cached.push(vertex);
                    return false; //
                },
                isCachedButWrongType: () => false,
                notCached: id => id
            };
            toFetch = query
                .map(id => cacheCheck(entity, ctx._cache, id, callbacks))
                .filter(Boolean);
        } else {
            toFetch = query;
        }
        const fetched = toFetch.length === 0
            ? Promise.resolve([])
            : ctx._connection
                  .ids(toFetch, options)
                  .then(vertexize(ctx, entity));

        return fetched.then(vertices => cached.concat(vertices));
    }
    //check cache first.
    if (!options.refetch) {
        const cached = cacheCheck(entity, ctx._cache, query, {
            isCached: vertex => vertex,
            isCachedButWrongType: () => false,
            notCached: () => false
        });
        if (cached) {
            return Promise.resolve(cached);
        }
    }
    return findOne(ctx, entity, { _id: query }, options);
}

/**
 * @ignore
 */
export function search(ctx, entity, query, filters = {}, options = {}) {
    return find(
        ctx,
        entity,
        Object.assign({ $search: query }, filters),
        options
    );
}

/**
 * @ignore
 */
export function create(ctx, entity, data, options = {}) {
    if (options.addCreatedOn && !data.created_on) {
        data.created_on = Date.now();
    }
    const dbData = entity.encode(data);
    return ctx._connection
        .create(entity.ogit, dbData, options)
        .then(vertexize(ctx, entity));
}

/**
 * @ignore
 */
export function update(ctx, entity, vertexId, data, options = {}) {
    const dbData = entity.encode(data);
    return ctx._connection
        .update(vertexId, dbData, options)
        .then(vertexize(ctx, entity));
}

/**
 * @ignore
 */
export function replace(ctx, entity, vertexId, data, options = {}) {
    const dbData = entity.encode(data);
    return ctx._connection
        .replace(vertexId, dbData, options)
        .then(vertexize(ctx, entity));
}

/**
 * @ignore
 */
export function deleteVertex(ctx, vertexId, options = {}) {
    return ctx._connection.delete(vertexId, options);
}

/**
 * @ignore
 */
export function connect(
    ctx,
    entity,
    { relation, source, target },
    options = {}
) {
    const relationDef = entity.relation(relation);
    if (!relationDef) {
        throw badRequest(`No Relation ${relation} defined for ${entity.name}`);
    }
    if (relationDef.hops.length > 1) {
        throw badRequest(
            `Cannot "connect" multi-hop relation ${relation} for ${entity.name}`
        );
    }
    const { verb, direction } = relationDef.hops[0];
    const [inId, outId] = direction === "in"
        ? [source, target]
        : [target, source];
    return ctx._connection.connect(verb, inId, outId, options);
}

/**
 * @ignore
 */
export function disconnect(
    ctx,
    entity,
    { relation, source, target },
    options = {}
) {
    const relationDef = entity.relation(relation);
    if (!relationDef) {
        throw badRequest(`No Relation ${relation} defined for ${entity.name}`);
    }
    if (relationDef.hops.length > 1) {
        throw badRequest(
            `Cannot "disconnect" multi-hop relation ${relation} for ${entity.name}`
        );
    }
    const { verb, direction } = relationDef.hops[0];
    const [inId, outId] = direction === "in"
        ? [source, target]
        : [target, source];
    return ctx._connection.disconnect(verb, inId, outId, options);
}

/**
 * @ignore
 */
export function gremlin(ctx, rootVertexId, query, options = {}) {
    const queryResults = ctx._connection.gremlin(
        rootVertexId,
        query.toString(),
        options
    );
    if (options.raw) {
        return queryResults;
    }
    return queryResults.then(vertexize(ctx));
}
