class RemoteHands < Formula
  desc "Autonomous phone-operated agentic coding control plane"
  homepage "https://github.com/Kushal-Padshala/remote-hands"
  url "https://registry.npmjs.org/remote-hands-cli/-/remote-hands-cli-0.1.5.tgz"
  sha256 "56b90727400bf1bc64a33218071864eb4fd32859bd2dcfaed3d6c821bdb3811f"
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
