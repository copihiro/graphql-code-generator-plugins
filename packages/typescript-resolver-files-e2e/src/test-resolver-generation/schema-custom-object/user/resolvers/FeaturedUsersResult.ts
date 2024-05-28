import type { FeaturedUsersResultResolvers } from './../../types.generated';
/*
 * Note: This object type is generated because "FeaturedUsersResultMapper" is declared. This is to ensure runtime safety.
 *
 * When a mapper is used, it is possible to hit runtime errors in some senarios:
 * - given a field name, the schema type's field type does not match mapper's field type
 * - or a schema type's field does not exist in the mapper's fields
 *
 * If you want to skip this file generation, remove the mapper or update the pattern in the `resolverGeneration.object` config.
 */
export const FeaturedUsersResult: FeaturedUsersResultResolvers = {
  /* Implement FeaturedUsersResult resolver logic here */
  names: async (_parent, _arg, _ctx) => {
    /* FeaturedUsersResult.names resolver is required because FeaturedUsersResult.names exists but FeaturedUsersResultMapper.names does not */
  },
};