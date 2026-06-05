import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { findUserById, normalizeEmail, verifyUserCredentials } from '@/lib/auth/users'
import { checkRateLimit } from '@/lib/rateLimit'

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: process.env.AUTH_TRUST_HOST === 'true' || !!process.env.VERCEL || process.env.NODE_ENV !== 'production',
  session: {
    strategy: 'jwt',
  },
  pages: {
    signIn: '/sign-in',
  },
  providers: [
    Credentials({
      name: 'Email',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email = typeof credentials?.email === 'string' ? normalizeEmail(credentials.email) : ''
        const password = typeof credentials?.password === 'string' ? credentials.password : ''

        if (!email || !password) {
          return null
        }

        const loginRate = checkRateLimit(`login:email:${email}`, {
          windowMs: 15 * 60_000,
          maxRequests: 8,
        })
        if (!loginRate.allowed) {
          return null
        }

        const user = await verifyUserCredentials(email, password)
        if (!user) {
          return null
        }

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          accessStatus: user.accessStatus,
        }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user, trigger, session }) {
      if (user?.id) {
        token.id = user.id
        token.accountDeleted = false
      }
      if (user && 'accessStatus' in user) {
        token.accessStatus = user.accessStatus === 'pending' ? 'pending' : 'approved'
      }
      if (user && 'image' in user) {
        token.image = typeof user.image === 'string' ? user.image : null
      }
      if (trigger === 'update') {
        const updated = session as { image?: unknown; accessStatus?: unknown; user?: { image?: unknown; accessStatus?: unknown } } | undefined
        const image = updated?.user?.image ?? updated?.image
        if (typeof image === 'string' || image === null) {
          token.image = image
        }
        const accessStatus = updated?.user?.accessStatus ?? updated?.accessStatus
        if (accessStatus === 'pending' || accessStatus === 'approved') {
          token.accessStatus = accessStatus
        }
      }
      return token
    },
    async session({ session, token }) {
      if (session.user && typeof token.id === 'string') {
        session.user.id = token.id
        let dbUser: Awaited<ReturnType<typeof findUserById>> | undefined
        try {
          dbUser = await findUserById(token.id)
        } catch {
          dbUser = undefined
        }
        if (dbUser) {
          session.user.name = dbUser.name
          session.user.email = dbUser.email
          session.user.image = dbUser.image
          session.user.accessStatus = dbUser.accessStatus
          session.user.accountDeleted = false
          return session
        }
        if (dbUser === null) {
          session.user.accountDeleted = true
          session.user.accessStatus = 'pending'
          return session
        }
      }
      if (session.user) {
        session.user.image = typeof token.image === 'string' ? token.image : null
        session.user.accessStatus = token.accessStatus === 'pending' ? 'pending' : 'approved'
        session.user.accountDeleted = token.accountDeleted === true
      }
      return session
    },
  },
})
