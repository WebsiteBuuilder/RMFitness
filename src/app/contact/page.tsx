import { FaWhatsapp, FaEnvelope, FaMapMarkerAlt } from 'react-icons/fa'

export default function Contact() {
  return (
    <main className="py-20">
      <div className="container">
        <h1 className="text-5xl font-display font-bold mb-12 text-center">Get in Touch</h1>
        
        <div className="grid md:grid-cols-2 gap-12">
          <div>
            <div className="bg-white rounded-xl shadow-lg p-8">
              <h2 className="text-2xl font-bold mb-6">Contact Information</h2>
              
              <div className="space-y-6">
                <a 
                  href="https://wa.me/+1234567890"
                  className="flex items-center text-jamaica-green hover:text-jamaica-green/80"
                >
                  <FaWhatsapp className="w-6 h-6 mr-3" />
                  <div>
                    <p className="font-semibold">WhatsApp</p>
                    <p className="text-gray-600">+1 (234) 567-890</p>
                  </div>
                </a>
                
                <a 
                  href="mailto:rupert@rmfitness.com"
                  className="flex items-center text-jamaica-green hover:text-jamaica-green/80"
                >
                  <FaEnvelope className="w-6 h-6 mr-3" />
                  <div>
                    <p className="font-semibold">Email</p>
                    <p className="text-gray-600">rupert@rmfitness.com</p>
                  </div>
                </a>
                
                <div className="flex items-center">
                  <FaMapMarkerAlt className="w-6 h-6 mr-3 text-jamaica-green" />
                  <div>
                    <p className="font-semibold">Location</p>
                    <p className="text-gray-600">Trelawny, Jamaica</p>
                  </div>
                </div>
              </div>
              
              <div className="mt-8">
                <h3 className="font-semibold mb-4">Training Hours</h3>
                <div className="space-y-2 text-gray-600">
                  <p>Monday - Friday: 6:00 AM - 8:00 PM</p>
                  <p>Saturday: 8:00 AM - 2:00 PM</p>
                  <p>Sunday: Closed</p>
                </div>
              </div>
            </div>
            
            <div className="mt-8">
              <a 
                href="https://wa.me/+1234567890"
                className="btn btn-primary w-full justify-center text-lg"
              >
                <FaWhatsapp className="mr-2" />
                Message on WhatsApp
              </a>
            </div>
          </div>
          
          <div className="h-[600px] rounded-xl overflow-hidden shadow-lg">
            <iframe
              src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d121894.73691673436!2d-77.6645843!3d18.3432723!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x8edce75e89166ac7%3A0x5f2ae89a80c11f8e!2sTrelawny%20Parish%2C%20Jamaica!5e0!3m2!1sen!2sus!4v1675893774225!5m2!1sen!2sus"
              width="100%"
              height="100%"
              style={{ border: 0 }}
              allowFullScreen
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </div>
        </div>
      </div>
    </main>
  )
} 