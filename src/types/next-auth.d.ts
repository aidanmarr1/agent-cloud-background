import type { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      accessStatus?: 'pending' | 'approved'
      accountDeleted?: boolean
    } & DefaultSession['user']
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string
    image?: string | null
    accessStatus?: 'pending' | 'approved'
    accountDeleted?: boolean
  }
}

declare module 'next-auth' {
  interface User {
    accessStatus?: 'pending' | 'approved'
  }
}
