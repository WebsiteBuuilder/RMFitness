import Image from 'next/image'

export default function About() {
  return (
    <main className="py-20">
      <div className="container">
        <h1 className="text-5xl font-display font-bold mb-12">About Rupert Bowen</h1>
        
        <div className="grid md:grid-cols-2 gap-12 items-start">
          <div>
            <div className="aspect-[3/4] relative rounded-xl overflow-hidden mb-6">
              <Image
                src="/rupert-profile.jpg"
                alt="Rupert Bowen"
                fill
                className="object-cover"
              />
            </div>
            
            <div className="bg-jamaica-green/10 p-6 rounded-xl">
              <h2 className="text-2xl font-bold mb-4">Certifications</h2>
              <ul className="space-y-3">
                {certifications.map((cert) => (
                  <li key={cert} className="flex items-center">
                    <svg className="w-5 h-5 text-jamaica-green mr-2" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    {cert}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          
          <div className="space-y-6">
            <section>
              <h2 className="text-2xl font-bold mb-4">My Journey</h2>
              <p className="text-gray-600">
                Born and raised in Trelawny, Jamaica, I discovered my passion for fitness at an early age. What started as a personal journey to transform my own body evolved into a mission to help others achieve their fitness goals.
              </p>
            </section>
            
            <section>
              <h2 className="text-2xl font-bold mb-4">Training Philosophy</h2>
              <p className="text-gray-600 mb-4">
                I believe that sustainable fitness is about more than just working out—it's about building healthy habits that last a lifetime. My approach combines:
              </p>
              <ul className="space-y-3 text-gray-600">
                {philosophyPoints.map((point) => (
                  <li key={point} className="flex items-start">
                    <span className="text-jamaica-green mr-2">•</span>
                    {point}
                  </li>
                ))}
              </ul>
            </section>
            
            <section>
              <h2 className="text-2xl font-bold mb-4">Why Choose Me?</h2>
              <div className="grid sm:grid-cols-2 gap-4">
                {benefits.map((benefit) => (
                  <div key={benefit.title} className="p-4 border border-gray-200 rounded-lg">
                    <h3 className="font-bold mb-2">{benefit.title}</h3>
                    <p className="text-gray-600 text-sm">{benefit.description}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  )
}

const certifications = [
  "NASM Certified Personal Trainer",
  "Precision Nutrition Level 1 Coach",
  "TRX Suspension Training Certified",
  "First Aid & CPR Certified"
]

const philosophyPoints = [
  "Progressive overload training for consistent results",
  "Balanced nutrition that fits your lifestyle",
  "Mind-body connection for holistic wellness",
  "Customized programs based on your goals"
]

const benefits = [
  {
    title: "Personalized Attention",
    description: "Every client receives a custom program tailored to their specific goals and needs."
  },
  {
    title: "Proven Results",
    description: "Track record of helping clients achieve significant transformations."
  },
  {
    title: "Flexible Training",
    description: "In-person and online options to fit your schedule."
  },
  {
    title: "Continuous Support",
    description: "24/7 WhatsApp support to keep you motivated and accountable."
  }
] 