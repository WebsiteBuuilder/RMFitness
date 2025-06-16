import React from 'react'
import { Montserrat, Poppins } from 'next/font/google'
import './globals.css'
import Navigation from '@/components/Navigation'
import Footer from '@/components/Footer'

const montserrat = Montserrat({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-montserrat',
})

const poppins = Poppins({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-poppins',
})

export const metadata = {
  title: 'R&M Fitness | Private Studio & Fitness Training | Trelawny, Jamaica',
  description: 'Transform your body and life with expert personal training in Trelawny, Jamaica. R&M Fitness offers personalized training programs in a private studio setting.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`${montserrat.variable} ${poppins.variable}`}>
      <head>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" />
        <link rel="icon" type="image/png" href="/images/rm-fitness-logo.png" />
      </head>
      <body className={`${poppins.className} text-dark-gray antialiased`}>
        <Navigation />
        {children}
        <Footer />
      </body>
    </html>
  )
} 