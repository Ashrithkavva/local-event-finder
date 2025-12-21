import { Loaders } from './loaders';

export type GraphQLContext = {
  requestId: string;
  loaders: Loaders;
};
