export const typeDefs = /* GraphQL */ `
  type Review {
    author: String!
    rating: Int!
    comment: String!
  }

  type Event {
    id: ID!
    name: String!
    venue: String!
    eventDate: String!
    totalSeats: Int!
    availableSeats: Int!
    description: String
    category: String
    reviews: [Review!]!
  }

  type Seat {
    id: ID!
    eventId: ID!
    rowLabel: String!
    seatNumber: Int!
    isBooked: Boolean!
  }

  type Booking {
    id: ID!
    eventId: ID!
    seatIds: [ID!]!
    userId: String!
    createdAt: String!
  }

  type Query {
    events: [Event!]!
    event(id: ID!): Event
    seats(eventId: ID!): [Seat!]!
  }

  type Mutation {
    bookSeats(eventId: ID!, seatIds: [ID!]!, userId: String!): Booking!
  }
`;
