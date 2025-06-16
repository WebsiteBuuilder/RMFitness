"use client"

import Link from 'next/link'
import Image from 'next/image'
import { FaWhatsapp, FaTiktok, FaInstagram, FaMapMarkerAlt, FaPhoneAlt, FaEnvelope } from 'react-icons/fa'

export default function Footer() {
  return (
    <footer className="bg-jamaica-green text-white">
      <div className="container mx-auto px-4 py-12">
        <div className="grid md:grid-cols-3 gap-12">
          {/* Company Info */}
          <div>
            <div className="flex items-center mb-6">
              <div className="h-20 w-20 bg-white rounded-lg">
                <img
                  src="/images/rm-fitness-logo.png"
                  alt="R&M Fitness Logo"
                  className="w-full h-full object-contain p-2"
                />
              </div>
            </div>
            <p className="mb-4">
              Transform your body and life with expert personal training in Trelawny, Jamaica. 
              Join us for a fitness journey that combines professional guidance with Jamaican energy.
            </p>
            <div className="flex space-x-4">
              <Link href="https://www.tiktok.com/@rm.fitness8?_t=ZT-8w4HI6nyije&_r=1" className="text-white hover:text-jamaica-yellow text-xl">
                <FaTiktok />
              </Link>
              <Link href="https://www.instagram.com/rupert_trainer_trelawny" className="text-white hover:text-jamaica-yellow text-xl">
                <FaInstagram />
              </Link>
              <Link href="https://wa.me/+18761234567" className="text-white hover:text-jamaica-yellow text-xl">
                <FaWhatsapp />
              </Link>
            </div>
          </div>

          {/* Quick Links */}
          <div>
            <h3 className="text-xl font-bold mb-6">Quick Links</h3>
            <ul className="space-y-3">
              <li>
                <Link href="/#about" className="hover:text-jamaica-yellow">About Us</Link>
              </li>
              <li>
                <Link href="/#services" className="hover:text-jamaica-yellow">Our Services</Link>
              </li>
              <li>
                <Link href="/#gallery" className="hover:text-jamaica-yellow">Gallery</Link>
              </li>
              <li>
                <Link href="/#testimonials" className="hover:text-jamaica-yellow">Testimonials</Link>
              </li>
              <li>
                <Link href="/#contact" className="hover:text-jamaica-yellow">Contact</Link>
              </li>
            </ul>
          </div>

          {/* Contact Info */}
          <div>
            <h3 className="text-xl font-bold mb-6">Contact Info</h3>
            <ul className="space-y-4">
              <li className="flex items-center">
                <FaMapMarkerAlt className="mr-3" />
                <span>Trelawny, Jamaica</span>
              </li>
              <li className="flex items-center">
                <FaPhoneAlt className="mr-3" />
                <a href="tel:+18761234567" className="hover:text-jamaica-yellow">
                  +1 (876) 123-4567
                </a>
              </li>
              <li className="flex items-center">
                <FaEnvelope className="mr-3" />
                <a href="mailto:info@rmfitness.com" className="hover:text-jamaica-yellow">
                  info@rmfitness.com
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t border-white/20 mt-12 pt-8 text-center">
          <p>&copy; {new Date().getFullYear()} R&M Fitness. All rights reserved.</p>
        </div>
      </div>
    </footer>
  )
} 