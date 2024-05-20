import * as path from 'path';
import {
  type GraphQLField,
  type GraphQLScalarType,
  type GraphQLSchema,
  type GraphQLObjectType,
  type Location,
  isObjectType,
  isScalarType,
  isSpecifiedScalarType,
  isUnionType,
  isInterfaceType,
} from 'graphql';
import type { ParseSourcesResult } from '../parseSources';
import type { TypeMappersMap } from '../parseTypeMappers';
import type {
  ParsedPresetConfig,
  ScalarsOverridesType,
} from '../validatePresetConfig';
import {
  logger,
  isNativeNamedType,
  isRootObjectType,
  parseLocationForWhitelistedModule,
  relativeModulePath,
  type RootObjectType,
} from '../utils';
import { parseLocationForOutputDir } from './parseLocationForOutputDir';
import { normalizeResolverName } from './normalizeResolverName';

interface ParseGraphQLSchemaParams {
  schemaAst: GraphQLSchema;
  sourceMap: ParseSourcesResult['sourceMap'];
  resolverTypesPath: string;
  typeMappersMap: TypeMappersMap;
  scalarsModule: ParsedPresetConfig['scalarsModule'];
  scalarsOverrides: ParsedPresetConfig['scalarsOverrides'];
  mode: ParsedPresetConfig['mode'];
  baseOutputDir: string;
  resolverRelativeTargetDir: string;
  whitelistedModules: ParsedPresetConfig['whitelistedModules'];
  blacklistedModules: ParsedPresetConfig['blacklistedModules'];
  federationEnabled: boolean;
}

export interface ResolverDetails {
  schemaType: string;
  moduleName: string;
  resolverFile: {
    name: string;
    path: string;
  };
  relativePathFromBaseToModule: string[];
  normalizedResolverName: ReturnType<typeof normalizeResolverName>;
  typeNamedImport: string;
  typeString: string;
  relativePathToResolverTypesFile: string;
}

type ObjectResolverDetails = ResolverDetails & {
  fieldsToPick: string[];
  pickReferenceResolver: boolean;
};

export interface ParsedGraphQLSchemaMeta {
  userDefinedSchemaTypeMap: {
    query: Record<
      string, // normalized resolver name
      ResolverDetails
    >;
    mutation: Record<
      string, // normalized resolver name
      ResolverDetails
    >;
    subscription: Record<
      string, // normalized resolver name
      ResolverDetails
    >;
    object: Record<
      string, // schema name e.g. `User`, `Job`, etc.
      Record<
        string, // normalized name e.g. `user.User` (modules) or `.User` (merged)
        ObjectResolverDetails
      >
    >;
    scalar: Record<string, ResolverDetails>;
    interface: Record<string, ResolverDetails>;
    union: Record<string, ResolverDetails>;
  };
  pluginsConfig: {
    defaultScalarTypesMap: Record<string, ScalarsOverridesType>;
    defaultScalarExternalResolvers: Record<string, string>;
    defaultTypeMappers: Record<string, string>;
  };
}

export const parseGraphQLSchema = async ({
  schemaAst,
  sourceMap,
  resolverTypesPath,
  typeMappersMap,
  scalarsModule,
  scalarsOverrides,
  mode,
  baseOutputDir,
  resolverRelativeTargetDir,
  whitelistedModules,
  blacklistedModules,
  federationEnabled,
}: ParseGraphQLSchemaParams): Promise<ParsedGraphQLSchemaMeta> => {
  const scalarResolverMap = scalarsModule
    ? await getScalarResolverMapFromModule(scalarsModule)
    : {};

  return Object.entries(schemaAst.getTypeMap()).reduce<ParsedGraphQLSchemaMeta>(
    (res, [schemaType, namedType]) => {
      if (isNativeNamedType(namedType)) {
        if (isSpecifiedScalarType(namedType)) {
          handleNativeScalarType({ schemaType, result: res, scalarsOverrides });
        }
        return res;
      }

      const parsedSource = parseLocationForWhitelistedModule({
        location: namedType.astNode?.loc,
        sourceMap,
        whitelistedModules,
        blacklistedModules,
      });
      if (!parsedSource) {
        return res;
      }

      // Root object types e.g. Query, Mutation, Subscription
      if (isRootObjectType(schemaType) && isObjectType(namedType)) {
        Object.entries(namedType.getFields()).forEach(
          ([fieldName, fieldNode]) => {
            const resolverDetails = createResolverDetails({
              belongsToRootObject: schemaType,
              mode,
              sourceMap,
              resolverRelativeTargetDir,
              resolverTypesPath,
              baseOutputDir,
              blacklistedModules,
              whitelistedModules,
              schemaType,
              nestedDirs: [schemaType],
              location: fieldNode.astNode?.loc,
              resolverName: fieldName,
            });
            if (!resolverDetails) {
              return;
            }

            res.userDefinedSchemaTypeMap[
              schemaType.toLowerCase() as 'query' | 'mutation' | 'subscription'
            ][resolverDetails.normalizedResolverName.withModule] =
              resolverDetails;
          }
        );
        return res;
      }

      // Other output object types
      if (!isRootObjectType(schemaType) && isObjectType(namedType)) {
        handleObjectType({
          mode,
          sourceMap,
          resolverTypesPath,
          resolverRelativeTargetDir,
          baseOutputDir,
          blacklistedModules,
          whitelistedModules,
          federationEnabled,
          typeMappersMap,
          namedType,
          schemaType,
          result: res,
        });
        return res;
      }

      // Handle scalar type wireups
      if (isScalarType(namedType)) {
        handleScalarType({
          scalarResolverMap,
          schemaType,
          scalarsModule,
          scalarsOverrides,
          result: res,
        });
      }

      // create resolver details for other types:
      // - Scalar
      // - Union
      // - Interface
      const resolverDetails = createResolverDetails({
        belongsToRootObject: null,
        mode,
        sourceMap,
        resolverRelativeTargetDir,
        resolverTypesPath,
        baseOutputDir,
        blacklistedModules,
        whitelistedModules,
        schemaType,
        nestedDirs: [],
        location: namedType.astNode?.loc,
        resolverName: namedType.name,
      });

      if (resolverDetails) {
        if (isScalarType(namedType)) {
          res.userDefinedSchemaTypeMap.scalar[schemaType] = resolverDetails;
        } else if (isUnionType(namedType)) {
          res.userDefinedSchemaTypeMap.union[schemaType] = resolverDetails;
        } else if (isInterfaceType(namedType)) {
          res.userDefinedSchemaTypeMap.interface[schemaType] = resolverDetails;
        }
      }

      return res;
    },
    {
      userDefinedSchemaTypeMap: {
        query: {},
        mutation: {},
        subscription: {},
        object: {},
        scalar: {},
        interface: {},
        union: {},
      },
      pluginsConfig: {
        defaultScalarTypesMap: {},
        defaultScalarExternalResolvers: {},
        defaultTypeMappers: {},
      },
    }
  );
};

const handleScalarType = ({
  scalarResolverMap,
  schemaType,
  result,
  scalarsModule,
  scalarsOverrides,
}: {
  scalarResolverMap: Record<string, GraphQLScalarType<unknown, unknown>>;
  schemaType: string;
  result: ParsedGraphQLSchemaMeta;
  scalarsModule: string | false;
  scalarsOverrides: ParsedPresetConfig['scalarsOverrides'];
}): void => {
  const scalarResolver = scalarResolverMap[schemaType];
  // Use found the scalar from scalar module
  if (scalarResolver) {
    if (
      scalarResolver.extensions.codegenScalarType &&
      typeof scalarResolver.extensions.codegenScalarType === 'string'
    ) {
      result.pluginsConfig.defaultScalarTypesMap[schemaType] =
        scalarResolver.extensions.codegenScalarType;
    }
    result.pluginsConfig.defaultScalarExternalResolvers[
      schemaType
    ] = `~${scalarsModule}#${scalarResolver.name}Resolver`;
  }

  // If found scalar overrides, use them
  const override = scalarsOverrides[schemaType];
  if (override) {
    if (override.type) {
      result.pluginsConfig.defaultScalarTypesMap[schemaType] = override.type;
    }
    if (override.resolver) {
      result.pluginsConfig.defaultScalarExternalResolvers[schemaType] =
        override.resolver;
    }
  }
};

const getScalarResolverMapFromModule = async (
  scalarsModule: string
): Promise<Record<string, GraphQLScalarType<unknown, unknown>>> => {
  let module:
    | { resolvers: Record<string, GraphQLScalarType<unknown, unknown>> }
    | undefined;
  try {
    module = await import(scalarsModule);
  } catch (err) {
    if (
      err instanceof Error &&
      'code' in err &&
      err.code === 'MODULE_NOT_FOUND'
    ) {
      logger.warn(
        `Unable to import \`${scalarsModule}\`. Install \`${scalarsModule}\` or you have to implement Scalar resolvers by yourself.`
      );
    }
  }

  if (!module || !module.resolvers) {
    return {};
  }

  return module.resolvers;
};

const handleNativeScalarType = ({
  schemaType,
  result,
  scalarsOverrides,
}: {
  schemaType: string;
  result: ParsedGraphQLSchemaMeta;
  scalarsOverrides: ParsedPresetConfig['scalarsOverrides'];
}): void => {
  const override = scalarsOverrides[schemaType];
  // Note: only override the type i.e. same functionality as `typescript` plugin's scalars
  // I've never seen someone overriding native scalar's implementation so it's probably not a thing.
  if (override && override.type) {
    result.pluginsConfig.defaultScalarTypesMap[schemaType] = override.type;
  }
};

const handleObjectType = ({
  mode,
  sourceMap,
  resolverTypesPath,
  resolverRelativeTargetDir,
  baseOutputDir,
  blacklistedModules,
  whitelistedModules,
  federationEnabled,
  typeMappersMap,
  namedType,
  schemaType,
  result,
}: {
  mode: ParseGraphQLSchemaParams['mode'];
  sourceMap: ParseGraphQLSchemaParams['sourceMap'];
  resolverTypesPath: ParseGraphQLSchemaParams['resolverTypesPath'];
  resolverRelativeTargetDir: ParseGraphQLSchemaParams['resolverRelativeTargetDir'];
  baseOutputDir: ParseGraphQLSchemaParams['baseOutputDir'];
  blacklistedModules: ParseGraphQLSchemaParams['blacklistedModules'];
  whitelistedModules: ParseGraphQLSchemaParams['whitelistedModules'];
  federationEnabled: ParseGraphQLSchemaParams['federationEnabled'];
  typeMappersMap: ParseGraphQLSchemaParams['typeMappersMap'];
  namedType: GraphQLObjectType;
  schemaType: string;
  result: ParsedGraphQLSchemaMeta;
}): void => {
  // Wire up `mappers` config
  const typeMapperDetails = typeMappersMap[schemaType];
  if (typeMapperDetails) {
    result.pluginsConfig.defaultTypeMappers[typeMapperDetails.schemaType] =
      typeMapperDetails.configImportPath;
  }

  // parse for details
  const fieldsByGraphQLModule = Object.entries(namedType.getFields()).reduce<
    Record<
      string,
      {
        fieldNodes: GraphQLField<unknown, unknown>[];
        firstFieldLocation: Location | undefined;
      }
    >
  >((res, [_, fieldNode]) => {
    const fieldLocation = fieldNode.astNode?.loc;
    const modulePath = path.dirname(fieldLocation?.source.name || '');

    if (!res[modulePath]) {
      res[modulePath] = {
        fieldNodes: [],
        // Note: fieldLocation here is the location of the first field found in a GraphQL Module.
        // The reason we use field's location instead of the object type's location is because when `extend type ObjectType` is used, the location of object type is the last found location.
        // i.e. we cannot rely on object's location if `extend type` is used.
        firstFieldLocation: fieldLocation,
      };
    }

    res[modulePath].fieldNodes.push(fieldNode);

    return res;
  }, {});

  let pickReferenceResolver = false;
  if (federationEnabled && namedType.astNode?.directives) {
    pickReferenceResolver = namedType.astNode.directives.some(
      (d) => d.name.value === 'key'
    );
  }

  result.userDefinedSchemaTypeMap.object[schemaType] =
    result.userDefinedSchemaTypeMap.object[schemaType] || {};

  Object.entries(fieldsByGraphQLModule).forEach(
    (
      [_modulePath, { firstFieldLocation, fieldNodes }],
      _index,
      graphQLModules
    ) => {
      const resolverDetails = createResolverDetails({
        belongsToRootObject: null,
        mode,
        sourceMap,
        resolverRelativeTargetDir,
        resolverTypesPath,
        baseOutputDir,
        blacklistedModules,
        whitelistedModules,
        schemaType,
        nestedDirs: [],
        location: firstFieldLocation,
        resolverName: namedType.name,
      });

      if (!resolverDetails) {
        return;
      }

      // If there are multiple object type files to generate
      // e.g. `extend type ObjectType` is used across multiple modules
      // We create an array of fields to pick for each module
      //
      // If there's only one module, we return an empty array i.e. pick all fields
      const fieldsToPick =
        graphQLModules.length > 1 ? fieldNodes.map((field) => field.name) : [];

      result.userDefinedSchemaTypeMap.object[schemaType][
        resolverDetails.normalizedResolverName.withModule
      ] = {
        ...resolverDetails,
        fieldsToPick,
        pickReferenceResolver,
      };
    }
  );
};

const createResolverDetails = ({
  belongsToRootObject,
  mode,
  sourceMap,
  resolverRelativeTargetDir,
  resolverTypesPath,
  baseOutputDir,
  blacklistedModules,
  whitelistedModules,
  schemaType,
  nestedDirs,
  location,
  resolverName,
}: {
  belongsToRootObject: RootObjectType | null;
  mode: ParseGraphQLSchemaParams['mode'];
  sourceMap: ParseGraphQLSchemaParams['sourceMap'];
  resolverRelativeTargetDir: ParseGraphQLSchemaParams['resolverRelativeTargetDir'];
  resolverTypesPath: ParseGraphQLSchemaParams['resolverTypesPath'];
  baseOutputDir: ParseGraphQLSchemaParams['baseOutputDir'];
  blacklistedModules: ParseGraphQLSchemaParams['blacklistedModules'];
  whitelistedModules: ParseGraphQLSchemaParams['whitelistedModules'];
  schemaType: string;
  nestedDirs: string[];
  location: Location | undefined;
  resolverName: string;
}): ResolverDetails | undefined => {
  const parsedDetails = parseLocationForOutputDir({
    nestedDirs,
    location,
    mode,
    sourceMap,
    resolverRelativeTargetDir,
    baseOutputDir,
    blacklistedModules,
    whitelistedModules,
  });
  if (!parsedDetails) {
    // No `parsedDetails` means the location is NOT whitelisted, ignore.
    return;
  }
  const { moduleName, resolversOutputDir, relativePathFromBaseToModule } =
    parsedDetails;

  const normalizedResolverName = normalizeResolverName(
    moduleName,
    resolverName,
    belongsToRootObject
  );

  return {
    schemaType,
    moduleName,
    resolverFile: {
      name: resolverName,
      path: path.posix.join(resolversOutputDir, `${resolverName}.ts`),
    },
    relativePathFromBaseToModule,
    normalizedResolverName,
    typeNamedImport: `${schemaType}Resolvers`, // TODO: use from `typescript-resolvers`'s `meta`
    typeString: belongsToRootObject
      ? `${schemaType}Resolvers['${resolverName}']`
      : `${schemaType}Resolvers`, // TODO: use from `typescript-resolvers`'s `meta`
    relativePathToResolverTypesFile: relativeModulePath(
      resolversOutputDir,
      resolverTypesPath
    ),
  };
};
