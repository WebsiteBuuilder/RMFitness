"use client"

import Link from 'next/link'
import { useState } from 'react'
import { FaWhatsapp, FaTiktok, FaInstagram } from 'react-icons/fa'

export default function Navigation() {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <nav className="fixed w-full bg-white shadow-lg z-50">
      <div className="container mx-auto px-4">
        <div className="flex justify-between items-center h-20">
          {/* Logo */}
          <Link href="/" className="flex items-center">
            <div className="text-jamaica-green font-display">
              <h1 className="text-2xl font-bold">R&M Fitness</h1>
              <span className="text-xs">Trelawny, Jamaica</span>
            </div>
          </Link>

          {/* Mobile Menu Button */}
          <button
            className="md:hidden text-gray-600 hover:text-jamaica-green"
            onClick={() => setIsOpen(!isOpen)}
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              {isOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center space-x-8">
            <Link href="/#about" className="text-gray-600 hover:text-jamaica-green">About</Link>
            <Link href="/#services" className="text-gray-600 hover:text-jamaica-green">Services</Link>
            <Link href="/#gallery" className="text-gray-600 hover:text-jamaica-green">Gallery</Link>
            <Link href="/#testimonials" className="text-gray-600 hover:text-jamaica-green">Testimonials</Link>
            <Link href="/#contact" className="text-gray-600 hover:text-jamaica-green">Contact</Link>
          </div>

          {/* Social Links */}
          <div className="hidden md:flex items-center space-x-4">
            <Link href="https://www.tiktok.com/@rm.fitness8?_t=ZT-8w4HI6nyije&_r=1" className="text-gray-600 hover:text-jamaica-green text-xl">
              <FaTiktok />
            </Link>
            <Link href="https://www.instagram.com/rupert_trainer_trelawny" className="text-gray-600 hover:text-jamaica-green text-xl">
              <FaInstagram />
            </Link>
            <Link href="https://wa.me/+18761234567" className="text-gray-600 hover:text-jamaica-green text-xl">
              <FaWhatsapp />
            </Link>
          </div>
        </div>

        {/* Mobile Menu */}
        <div className={`md:hidden ${isOpen ? 'block' : 'hidden'} pb-4`}>
          <div className="flex flex-col space-y-4">
            <Link href="/#about" className="text-gray-600 hover:text-jamaica-green">About</Link>
            <Link href="/#services" className="text-gray-600 hover:text-jamaica-green">Services</Link>
            <Link href="/#gallery" className="text-gray-600 hover:text-jamaica-green">Gallery</Link>
            <Link href="/#testimonials" className="text-gray-600 hover:text-jamaica-green">Testimonials</Link>
            <Link href="/#contact" className="text-gray-600 hover:text-jamaica-green">Contact</Link>
          </div>
          <div className="flex space-x-4 mt-4">
            <Link href="https://www.tiktok.com/@rm.fitness8?_t=ZT-8w4HI6nyije&_r=1" className="text-gray-600 hover:text-jamaica-green text-xl">
              <FaTiktok />
            </Link>
            <Link href="https://www.instagram.com/rupert_trainer_trelawny" className="text-gray-600 hover:text-jamaica-green text-xl">
              <FaInstagram />
            </Link>
            <Link href="https://wa.me/+18761234567" className="text-gray-600 hover:text-jamaica-green text-xl">
              <FaWhatsapp />
            </Link>
          </div>
        </div>
      </div>
    </nav>
  )
} 