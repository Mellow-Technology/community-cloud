/*
 * sysctl net.ipv4.tcp_congestion_control
 * sysctl net.ipv4.tcp_available_congestion_control
 *
 *
 * sudo modprobe tcp_bbr
 * echo 'tcp_bbr' | sudo tee -a /etc/modules-load.d/modules.conf
 *
 *
 * echo 'net.core.default_qdisc = fq' >>  /etc/sysctl.conf
 * echo 'net.ipv4.tcp_congestion_control = bbr' >> /etc/sysctl.conf
 *
 * sysctl net.ipv4.tcp_congestion_control
 */
