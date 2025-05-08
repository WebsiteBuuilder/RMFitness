"use client"

import { FaTiktok, FaInstagram } from 'react-icons/fa'

export default function Testimonials() {
  return (
    <main className="py-20">
      <div className="container">
        <h1 className="text-5xl font-display font-bold mb-12 text-center">Client Success Stories</h1>
        
        <div className="grid md:grid-cols-2 gap-12">
          {/* TikTok Section */}
          <section>
            <div className="flex items-center mb-8">
              <FaTiktok className="w-8 h-8 text-jamaica-green mr-3" />
              <h2 className="text-2xl font-bold">TikTok Transformations</h2>
            </div>
            
            <div className="space-y-6">
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
          </section>
          
          {/* Instagram Section */}
          <section>
            <div className="flex items-center mb-8">
              <FaInstagram className="w-8 h-8 text-jamaica-green mr-3" />
              <h2 className="text-2xl font-bold">Instagram Results</h2>
            </div>
            
            <div className="space-y-6">
              <div className="aspect-square w-full max-w-sm mx-auto">
                <blockquote 
                  className="instagram-media" 
                  data-instgrm-permalink="https://www.instagram.com/rupert_trainer_trelawny/"
                  data-instgrm-version="14"
                  style={{ 
                    background: '#FFF',
                    border: '0',
                    borderRadius: '3px',
                    boxShadow: '0 0 1px 0 rgba(0,0,0,0.5),0 1px 10px 0 rgba(0,0,0,0.15)',
                    margin: '1px',
                    maxWidth: '540px',
                    minWidth: '326px',
                    padding: '0',
                    width: 'calc(100% - 2px)'
                  }}
                >
                </blockquote>
                <script async src="//www.instagram.com/embed.js"></script>
              </div>
            </div>
          </section>
        </div>
        
        {/* Written Testimonials */}
        <section className="mt-20">
          <h2 className="text-3xl font-bold text-center mb-12">What My Clients Say</h2>
          
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
            {testimonials.map((testimonial) => (
              <div key={testimonial.name} className="bg-white rounded-xl shadow-lg p-6">
                <div className="flex items-center mb-4">
                  <div className="w-12 h-12 rounded-full bg-jamaica-green/10 flex items-center justify-center text-jamaica-green font-bold text-xl">
                    {testimonial.name[0]}
                  </div>
                  <div className="ml-3">
                    <p className="font-bold">{testimonial.name}</p>
                    <p className="text-sm text-gray-600">{testimonial.achievement}</p>
                  </div>
                </div>
                <p className="text-gray-600 italic">"{testimonial.quote}"</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  )
}

const tiktokVideos = [
  { id: '7123456789012345678' },
  { id: '7123456789012345679' },
  { id: '7123456789012345680' }
]

const instagramPosts = [
  { id: 'ABC123xyz' },
  { id: 'DEF456uvw' },
  { id: 'GHI789rst' }
]

const testimonials = [
  {
    name: "Sarah Johnson",
    achievement: "Lost 30 lbs in 6 months",
    quote: "Rupert's personalized approach and constant motivation helped me achieve what I thought was impossible. The transformation has been life-changing!"
  },
  {
    name: "Marcus Brown",
    achievement: "Gained 15 lbs muscle mass",
    quote: "The online coaching program is fantastic! Rupert's attention to detail and form correction through video analysis is top-notch."
  },
  {
    name: "Lisa Thompson",
    achievement: "Completed first marathon",
    quote: "From barely running a mile to finishing a marathon - Rupert's training and nutrition guidance made it all possible. Forever grateful!"
  }
] 