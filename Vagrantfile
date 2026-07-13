require 'fileutils'

Vagrant.configure("2") do |config|
  # Base box, we use Ubuntu 24.04
  config.vm.box = "bento/ubuntu-24.04"
  config.vm.box_version = "202510.26.0"

  # Loop to create 3 identical boxes
  (1..3).each do |i|
      config.vm.define "box#{i}" do |box|
        box.vm.provider "virtualbox" do |v, instance|
          # CPU & Memory
          v.memory = 4096
          v.cpus = 2

          # Base directory for virtual disks
          disk_dir = File.join(Dir.pwd, ".vagrant", "machines", instance.name, "virtualbox")
          FileUtils.mkdir_p(disk_dir)

          # Attach 3 disks (ports 0, 1, 2 on the SATA controller)
          1.upto(3) do |disk_num|
            disk_path = File.join(disk_dir, "box#{i}_disk#{disk_num}.vdi")

            # Create 25GB disk
            v.customize ["createhd", "--filename", disk_path, "--size", 25600]

            # Attach to SATA controller
            v.customize ["storageattach", instance.id, "--storagectl", "SATA",
                         "--port", disk_num - 1, "--device", 0,
                         "--type", "hdd", "--medium", disk_path]
          end
        end
      end
    end
  end
