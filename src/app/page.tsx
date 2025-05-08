import React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { FaDumbbell, FaHeart, FaUsers, FaLeaf, FaAppleAlt, FaRunning, FaTiktok, FaMapMarkerAlt, FaPhoneAlt, FaEnvelope, FaClock, FaWhatsapp } from 'react-icons/fa'
import SocialFeed from '@/components/SocialFeed'

export default function Home() {
  return (
    <main>
      {/* Hero Section */}
      <section className="relative min-h-screen flex items-center bg-hero-pattern bg-cover bg-center">
        <div className="absolute inset-0 bg-gradient-to-r from-jamaica-green/70 to-jamaica-yellow/70 opacity-30" />
        <div className="jamaican-flag-animation">
          <div className="flag-stripe" />
          <div className="flag-stripe" />
          <div className="flag-stripe" />
          <div className="flag-stripe" />
        </div>
        <div className="container relative z-10">
          <div className="max-w-3xl text-white">
            <h1 className="text-5xl md:text-6xl mb-6 leading-tight">
              Transform Your Body, Transform Your Life
            </h1>
            <p className="text-lg md:text-xl mb-8 opacity-90">
              R&M Fitness offers personalized training programs in a private studio setting in beautiful Trelawny, Jamaica. 
              Our expert trainers will help you achieve your fitness goals with customized workouts and nutrition plans.
            </p>
            <div className="space-x-4">
              <Link href="/contact" className="btn">
                Book a Session
              </Link>
              <Link href="/services" className="btn btn-secondary">
                Our Services
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* About Section */}
      <section className="section bg-light-gray" id="about">
        <div className="container">
          <div className="section-title">
            <span>ABOUT US</span>
            <h2>Who We Are</h2>
          </div>
          <div className="flex flex-col lg:flex-row items-center gap-12">
            <div className="lg:w-1/2 relative">
              <div className="relative z-10">
                <Image
                  src="/images/trainer.jpg"
                  alt="R&M Fitness Trainer"
                  width={600}
                  height={400}
                  className="rounded-xl shadow-xl"
                />
              </div>
              <div className="absolute -top-5 -left-5 w-full h-full border-4 border-jamaica-yellow rounded-xl z-0" />
            </div>
            <div className="lg:w-1/2">
              <h3 className="text-3xl text-jamaica-green mb-6">
                Your Journey to Fitness Excellence Starts Here
              </h3>
              <p className="mb-6">
                R&M Fitness is a premier private fitness studio located in the heart of Trelawny, Jamaica. 
                Founded with a passion for helping people transform their lives through fitness, we provide 
                personalized training programs tailored to your unique needs and goals.
              </p>
              <p className="mb-8">
                Our approach combines traditional Jamaican vitality with modern fitness science to create 
                a unique training experience that energizes both body and mind. We believe fitness should 
                be accessible, enjoyable, and sustainable for everyone.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                <Feature
                  icon={<FaDumbbell />}
                  title="Personalized Training"
                  description="Custom programs for your specific goals"
                />
                <Feature
                  icon={<FaHeart />}
                  title="Holistic Approach"
                  description="Focus on mind, body, and nutrition"
                />
                <Feature
                  icon={<FaUsers />}
                  title="Private Sessions"
                  description="One-on-one attention in a private setting"
                />
                <Feature
                  icon={<FaLeaf />}
                  title="Jamaican Influence"
                  description="Training infused with island energy"
                />
              </div>
              <Link href="/contact" className="btn">
                Start Your Journey
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Services Section */}
      <section className="section bg-white" id="services">
        <div className="container">
          <div className="section-title">
            <span>SERVICES</span>
            <h2>What We Offer</h2>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
            {services.map((service) => (
              <div 
                key={service.title}
                className="bg-light-gray rounded-xl overflow-hidden shadow-lg transition-transform hover:-translate-y-2"
              >
                <div className="relative h-64">
                  <Image
                    src={service.image}
                    alt={service.title}
                    fill
                    className="object-cover"
                  />
                </div>
                <div className="p-6">
                  <h3 className="text-2xl text-jamaica-green mb-4">{service.title}</h3>
                  <p className="text-gray-600 mb-6">{service.description}</p>
                  <Link href="/contact" className="btn">
                    {service.cta}
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Gallery Section */}
      <section className="section bg-light-gray" id="gallery">
        <div className="container">
          <div className="section-title">
            <span>GALLERY</span>
            <h2>Training in Action</h2>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {galleryImages.map((image, index) => (
              <div 
                key={index}
                className="relative aspect-square group overflow-hidden rounded-xl"
              >
                <Image
                  src={image.src}
                  alt={image.alt}
                  fill
                  className="object-cover transition-transform group-hover:scale-110"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="absolute bottom-4 left-4 text-white">
                    <p className="text-sm">{image.caption}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Social Feed Section */}
      <SocialFeed />

      {/* Testimonials Section */}
      <section className="section bg-white" id="testimonials">
        <div className="container">
          <div className="section-title">
            <span>TESTIMONIALS</span>
            <h2>Success Stories</h2>
          </div>
          
          <div className="grid md:grid-cols-2 gap-12">
            {/* TikTok Section */}
            <div>
              <h3 className="text-2xl font-bold mb-6 flex items-center">
                <FaTiktok className="text-jamaica-green mr-3" />
                TikTok Transformations
              </h3>
              <div className="aspect-[9/16] w-full max-w-sm mx-auto">
                <blockquote 
                  className="tiktok-embed" 
                  cite="https://www.tiktok.com/@rm.fitness8/video/7338475883894775045"
                  data-video-id="7338475883894775045"
                >
                  <section>
                    <a target="_blank" href="https://www.tiktok.com/@rm.fitness8">@rm.fitness8</a>
                  </section>
                </blockquote>
                <script async src="https://www.tiktok.com/embed.js"></script>
              </div>
            </div>

            {/* Written Testimonials */}
            <div>
              <h3 className="text-2xl font-bold mb-6">Client Reviews</h3>
              <div className="space-y-6">
                {testimonials.map((testimonial, index) => (
                  <div 
                    key={index}
                    className="bg-light-gray p-6 rounded-xl"
                  >
                    <div className="flex items-center mb-4">
                      <div className="w-12 h-12 rounded-full bg-jamaica-green/10 flex items-center justify-center text-jamaica-green font-bold text-xl">
                        {testimonial.name[0]}
                      </div>
                      <div className="ml-4">
                        <h4 className="font-bold">{testimonial.name}</h4>
                        <p className="text-sm text-gray-600">{testimonial.achievement}</p>
                      </div>
                    </div>
                    <p className="italic text-gray-600">"{testimonial.quote}"</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Contact Section */}
      <section className="section bg-light-gray" id="contact">
        <div className="container">
          <div className="section-title">
            <span>CONTACT</span>
            <h2>Get In Touch</h2>
          </div>
          
          <div className="grid lg:grid-cols-2 gap-12">
            {/* Contact Info */}
            <div>
              <h3 className="text-2xl font-bold mb-8">Contact Information</h3>
              <div className="space-y-6">
                <ContactDetail
                  icon={<FaMapMarkerAlt />}
                  title="Location"
                  content="Trelawny, Jamaica"
                />
                <ContactDetail
                  icon={<FaPhoneAlt />}
                  title="Phone"
                  content={
                    <a href="tel:+18761234567" className="hover:text-jamaica-green">
                      +1 (876) 123-4567
                    </a>
                  }
                />
                <ContactDetail
                  icon={<FaEnvelope />}
                  title="Email"
                  content={
                    <a href="mailto:info@rmfitness.com" className="hover:text-jamaica-green">
                      info@rmfitness.com
                    </a>
                  }
                />
                <ContactDetail
                  icon={<FaClock />}
                  title="Working Hours"
                  content={
                    <>
                      <p>Monday - Friday: 6am - 8pm</p>
                      <p>Saturday: 8am - 4pm</p>
                      <p>Sunday: Closed</p>
                    </>
                  }
                />
              </div>
            </div>

            {/* Contact Form */}
            <div className="bg-white p-8 rounded-xl shadow-lg">
              <form className="space-y-6">
                <div>
                  <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
                    Your Name
                  </label>
                  <input
                    type="text"
                    id="name"
                    name="name"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-jamaica-green focus:border-transparent"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                    Your Email
                  </label>
                  <input
                    type="email"
                    id="email"
                    name="email"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-jamaica-green focus:border-transparent"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1">
                    Your Phone
                  </label>
                  <input
                    type="tel"
                    id="phone"
                    name="phone"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-jamaica-green focus:border-transparent"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="message" className="block text-sm font-medium text-gray-700 mb-1">
                    Message
                  </label>
                  <textarea
                    id="message"
                    name="message"
                    rows={4}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-jamaica-green focus:border-transparent"
                    required
                  ></textarea>
                </div>
                <button type="submit" className="btn w-full">
                  Send Message
                </button>
              </form>
            </div>
          </div>
        </div>

        {/* WhatsApp Button */}
        <a
          href="https://wa.me/+18761234567"
          className="fixed bottom-8 right-8 w-16 h-16 bg-[#25D366] rounded-full flex items-center justify-center text-white text-2xl shadow-lg hover:scale-110 transition-transform z-50"
          target="_blank"
          rel="noopener noreferrer"
        >
          <FaWhatsapp />
        </a>
      </section>
    </main>
  )
}

function Feature({ icon, title, description }: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="flex items-start gap-4">
      <div className="text-2xl text-jamaica-green">
        {icon}
      </div>
      <div>
        <h4 className="font-semibold mb-1">{title}</h4>
        <p className="text-sm text-gray-600">{description}</p>
      </div>
    </div>
  )
}

const services = [
  {
    title: "Personal Training",
    description: "One-on-one personalized training sessions tailored to your specific fitness goals, whether it's weight loss, muscle gain, or overall fitness improvement.",
    image: "/images/personal-training.jpg",
    cta: "Book Session"
  },
  {
    title: "Nutrition Coaching",
    description: "Comprehensive nutrition plans incorporating local Jamaican superfoods and international nutrition science to complement your fitness routine.",
    image: "/images/nutrition.jpg",
    cta: "Get Plan"
  },
  {
    title: "Group Training",
    description: "Energetic small group sessions that combine the benefits of personal attention with the motivation of group dynamics.",
    image: "/images/group-training.jpg",
    cta: "Join Group"
  }
]

const galleryImages = [
  {
    src: "/images/gallery-1.jpg",
    alt: "Weight Training",
    caption: "Building strength with proper form"
  },
  {
    src: "/images/gallery-2.jpg",
    alt: "Cardio Session",
    caption: "High-intensity cardio workout"
  },
  {
    src: "/images/gallery-3.jpg",
    alt: "Stretching",
    caption: "Flexibility and mobility training"
  },
  {
    src: "/images/gallery-4.jpg",
    alt: "Nutrition",
    caption: "Healthy meal preparation"
  },
  {
    src: "/images/gallery-5.jpg",
    alt: "Group Training",
    caption: "Motivating group session"
  },
  {
    src: "/images/gallery-6.jpg",
    alt: "Beach Workout",
    caption: "Training in paradise"
  }
]

const testimonials = [
  {
    name: "Sarah Johnson",
    achievement: "Lost 30 lbs in 6 months",
    quote: "R&M Fitness completely transformed my approach to health and fitness. The personalized training program was exactly what I needed!"
  },
  {
    name: "Marcus Brown",
    achievement: "Gained 15 lbs muscle mass",
    quote: "The combination of expert guidance and motivation helped me achieve my muscle gain goals. Highly recommended!"
  },
  {
    name: "Lisa Thompson",
    achievement: "Completed first marathon",
    quote: "From barely running a mile to finishing a marathon - the training and nutrition guidance made it all possible!"
  }
]

function ContactDetail({ icon, title, content }: {
  icon: React.ReactNode
  title: string
  content: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-4">
      <div className="w-12 h-12 rounded-full bg-jamaica-green flex items-center justify-center text-white text-xl">
        {icon}
      </div>
      <div>
        <h4 className="font-semibold mb-1">{title}</h4>
        <div className="text-gray-600">{content}</div>
      </div>
    </div>
  )
} 