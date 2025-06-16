"use client"

import React from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useState } from 'react'
import { FaWhatsapp, FaTiktok, FaInstagram } from 'react-icons/fa'

export default function Navigation() {
  const [isOpen, setIsOpen] = useState(false)

  // Handle smooth scrolling for anchor links
  const handleScrollToSection = (e: React.MouseEvent<HTMLAnchorElement, MouseEvent>, targetId: string) => {
    e.preventDefault()
    setIsOpen(false) // Close mobile menu if open
    
    // Handle home page scrolling
    if (window.location.pathname === '/' || window.location.pathname === '') {
      const targetElement = document.getElementById(targetId)
      if (targetElement) {
        window.scrollTo({
          top: targetElement.offsetTop - 80, // Offset for the fixed navbar
          behavior: 'smooth'
        })
      }
    } else {
      // If on another page, navigate back to homepage with hash
      window.location.href = `/#${targetId}`
    }
  }

  return (
    <nav className="fixed w-full bg-white shadow-lg z-50">
      <div className="container mx-auto px-4">
        <div className="flex justify-between items-center h-20">
          {/* Logo */}
          <Link href="/" className="flex items-center">
            <div className="h-20 w-20">
              <img
                src="/images/rm-fitness-logo.png"
                alt="R&M Fitness Logo"
                className="w-full h-full object-contain"
              />
            </div>
            <div className="text-jamaica-green font-display ml-2 hidden md:block">
              <span className="text-sm">Trelawny, Jamaica</span>
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
            <a href="/#about" onClick={(e) => handleScrollToSection(e, 'about')} className="text-gray-600 hover:text-jamaica-green">About</a>
            <a href="/#services" onClick={(e) => handleScrollToSection(e, 'services')} className="text-gray-600 hover:text-jamaica-green">Services</a>
            <a href="/#gallery" onClick={(e) => handleScrollToSection(e, 'gallery')} className="text-gray-600 hover:text-jamaica-green">Gallery</a>
            <a href="/#testimonials" onClick={(e) => handleScrollToSection(e, 'testimonials')} className="text-gray-600 hover:text-jamaica-green">Testimonials</a>
            <a href="/#contact" onClick={(e) => handleScrollToSection(e, 'contact')} className="text-gray-600 hover:text-jamaica-green">Contact</a>
          </div>

          {/* Social Links */}
          <div className="hidden md:flex items-center space-x-4">
            <Link href="https://www.tiktok.com/@rm.fitness8?is_from_webapp=1&sender_device=pc" className="text-gray-600 hover:text-jamaica-green text-xl">
              <FaTiktok />
            </Link>
            <Link href="https://www.instagram.com/rupert_trainer_trelawny" className="text-gray-600 hover:text-jamaica-green text-xl">
              <FaInstagram />
            </Link>
            <Link href="https://wa.me/+18765627980" className="text-gray-600 hover:text-jamaica-green text-xl">
              <FaWhatsapp />
            </Link>
          </div>
        </div>

        {/* Mobile Menu */}
        <div className={`md:hidden ${isOpen ? 'block' : 'hidden'} pb-4`}>
          <div className="flex flex-col space-y-4">
            <a href="/#about" onClick={(e) => handleScrollToSection(e, 'about')} className="text-gray-600 hover:text-jamaica-green">About</a>
            <a href="/#services" onClick={(e) => handleScrollToSection(e, 'services')} className="text-gray-600 hover:text-jamaica-green">Services</a>
            <a href="/#gallery" onClick={(e) => handleScrollToSection(e, 'gallery')} className="text-gray-600 hover:text-jamaica-green">Gallery</a>
            <a href="/#testimonials" onClick={(e) => handleScrollToSection(e, 'testimonials')} className="text-gray-600 hover:text-jamaica-green">Testimonials</a>
            <a href="/#contact" onClick={(e) => handleScrollToSection(e, 'contact')} className="text-gray-600 hover:text-jamaica-green">Contact</a>
          </div>
          <div className="flex space-x-4 mt-4">
            <Link href="https://www.tiktok.com/@rm.fitness8?is_from_webapp=1&sender_device=pc" className="text-gray-600 hover:text-jamaica-green text-xl">
              <FaTiktok />
            </Link>
            <Link href="https://www.instagram.com/rupert_trainer_trelawny" className="text-gray-600 hover:text-jamaica-green text-xl">
              <FaInstagram />
            </Link>
            <Link href="https://wa.me/+18765627980" className="text-gray-600 hover:text-jamaica-green text-xl">
              <FaWhatsapp />
            </Link>
          </div>
        </div>
      </div>
    </nav>
  )
} 