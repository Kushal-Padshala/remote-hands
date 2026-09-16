class RemoteHands < Formula
  desc "Autonomous phone-operated agentic coding control plane"
  homepage "https://github.com/Kushal-Padshala/remote-hands"
  url "https://registry.npmjs.org/remote-hands-cli/-/remote-hands-cli-0.1.3.tgz"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    system "#{bin}/rh", "--help"
  end
end
