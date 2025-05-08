import Link from 'next/link'
import { FaWhatsapp } from 'react-icons/fa'

export default function Services() {
  return (
    <main className="py-20">
      <div className="container">
        <h1 className="text-5xl font-display font-bold mb-12 text-center">Training Services</h1>
        
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {services.map((service) => (
            <div key={service.title} className="bg-white rounded-xl shadow-lg overflow-hidden">
              <div className="aspect-video relative bg-jamaica-green/10">
                <div className="absolute inset-0 flex items-center justify-center">
                  {service.icon}
                </div>
              </div>
              
              <div className="p-6">
                <h2 className="text-2xl font-bold mb-4">{service.title}</h2>
                <p className="text-gray-600 mb-6">{service.description}</p>
                
                <div className="space-y-3 mb-6">
                  <h3 className="font-semibold">Includes:</h3>
                  <ul className="space-y-2">
                    {service.features.map((feature) => (
                      <li key={feature} className="flex items-center text-sm">
                        <svg className="w-4 h-4 text-jamaica-green mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                        {feature}
                      </li>
                    ))}
                  </ul>
                </div>
                
                <div className="space-y-3">
                  <p className="font-semibold">Starting from:</p>
                  <p className="text-2xl font-bold text-jamaica-green">{service.price}</p>
                </div>
                
                <Link 
                  href="https://wa.me/+1234567890"
                  className="btn btn-primary w-full mt-6 justify-center"
                >
                  <FaWhatsapp className="mr-2" />
                  Contact via WhatsApp
                </Link>
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  )
}

const services = [
  {
    title: "1-on-1 Personal Training",
    description: "Personalized training sessions at our Trelawny studio, tailored to your specific goals and fitness level.",
    icon: <svg className="w-12 h-12 text-jamaica-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>,
    features: [
      "Initial fitness assessment",
      "Customized workout plans",
      "Form correction and technique guidance",
      "Progress tracking",
      "Nutrition advice",
      "Flexible scheduling"
    ],
    price: "$80/session"
  },
  {
    title: "Online Coaching",
    description: "Expert guidance and accountability from anywhere in the world through our digital training platform.",
    icon: <svg className="w-12 h-12 text-jamaica-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
    </svg>,
    features: [
      "Weekly video check-ins",
      "Custom workout programs",
      "Form video analysis",
      "24/7 WhatsApp support",
      "Progress tracking app",
      "Monthly program updates"
    ],
    price: "$199/month"
  },
  {
    title: "Nutrition Coaching",
    description: "Comprehensive nutrition guidance to optimize your results and develop healthy eating habits for life.",
    icon: <svg className="w-12 h-12 text-jamaica-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
    </svg>,
    features: [
      "Personalized meal plans",
      "Shopping lists",
      "Recipe suggestions",
      "Supplement guidance",
      "Regular check-ins",
      "Habit coaching"
    ],
    price: "$149/month"
  }
] 